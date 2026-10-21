// node scripts/ui-smoke.ts BASE_URL [SCREENSHOT_DIR]
//
// Browser smoke test of the UI (implementation slice 5b): headless Chromium through playwright-core
// against a running server, the Node runtime or `wrangler dev`, that `pnpm run seed:dev` has just
// seeded (issuing-ca-2's delta target still without a CRL: the first run uploads it). Not part of
// ci:*. For each of en / zh-CN × light / dark (the browser's language and colour scheme):
//
// - the pre-paint theme script alone (the bundle replaced by an empty script) sets the theme of the
//   colour scheme: it runs under the CSP, allowed by its hash;
// - overview: site name, health, the five stats, three certificates and five targets, the page
//   title in the UI language;
// - deep links /certificates/<issuing-ca-1> and /crls/<its full target>, each reloaded: the
//   selected tab is highlighted, the CA Version extension opens with its animation, the revoked
//   list has the CRL's entries;
// - upload card: issuing-ca-2's delta CRL pasted as PEM → created (first context only), again →
//   unchanged, issuing-ca-1's older full-01 → the stale_crl alert, each worded in the UI language;
// - an unknown path and a malformed id → NotFound without an API request; an unknown target → its
//   "does not exist" state;
// - an explicit theme survives a reload, with and without the bundle;
// - no console error or warning (except Chrome's own "Failed to load resource" line for a response
//   the step expects: the 409 of the stale upload, the 404 of the unknown target), no uncaught
//   exception and no securitypolicyviolation event.
//
// Then the overview at 390 px must not scroll sideways. With SCREENSHOT_DIR, full-page PNGs go
// there: <page>-<locale>-<theme>.png at 1280×900 for overview, certificate (+ -extensions), crl
// (+ -revoked) and upload, and overview-en-light-390.png. Prints one line per check, exits 1 if
// any failed (2 on usage errors).
//
// Browser: $AIA_CHROMIUM, else the newest ~/.cache/ms-playwright/chromium_headless_shell-*
// (`pnpm exec playwright-core install --only-shell chromium`).
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { fixture, manifest } from "../tests/fixtures/pki.ts";

type Locale = "en" | "zh-CN";
type Theme = "light" | "dark";

// The browser globals of the functions that run in the page (evaluate, addInitScript, …). This
// file is type-checked in the Node program, which has no DOM lib; declared here, in module scope,
// they reach nothing else.
interface CspViolation {
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}
interface PageAnimation {
  playState: string;
  effect: { getTiming: () => { iterations?: number } } | null;
}
declare const document: {
  documentElement: {
    lang: string;
    scrollWidth: number;
    classList: { contains: (name: string) => boolean };
  };
  getAnimations: () => PageAnimation[];
  addEventListener: (
    type: "securitypolicyviolation",
    listener: (event: CspViolation) => void
  ) => void;
};
declare const window: { innerWidth: number; __aiaCspViolation: (text: string) => Promise<void> };
declare function getComputedStyle(element: unknown): {
  backgroundColor: string;
  animationName: string;
};

const LOCALES: Locale[] = ["en", "zh-CN"];
const THEMES: Theme[] = ["light", "dark"];
const CA_VERSION = "1.3.6.1.4.1.311.21.1";
const UNKNOWN_TARGET = "00000000-0000-4000-8000-000000000000";
/** The CRL uploaded as new, and the older CRL of a published target. */
const NEW_CRL = "crls/issuing-ca-2/delta-01.der";
const OLD_CRL = "crls/issuing-ca-1/full-01.pem";
const TIMEOUT_MS = 15_000;
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const [baseArg, shotsArg] = process.argv.slice(2);
if (baseArg === undefined || !/^https?:\/\/[^/]+\/?$/.test(baseArg)) {
  console.error("usage: node scripts/ui-smoke.ts BASE_URL [SCREENSHOT_DIR]");
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, "");
// Never hang a terminal: the whole run takes well under a minute.
setTimeout(() => {
  console.error("ui-smoke: no result after 5 minutes");
  process.exit(1);
}, 300_000).unref();

// Checks -----------------------------------------------------------------------------------------

let failures = 0;

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${description}`);
  if (!ok) {
    failures += 1;
  }
}

/** Runs one step; an exception (a selector that never appeared, …) fails it and the run goes on. */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    check(
      false,
      `${name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`
    );
  }
}

// Data -------------------------------------------------------------------------------------------

const MESSAGES = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`../src/web/locales/${locale}.json`, import.meta.url), "utf8")),
  ])
) as Record<Locale, unknown>;

/** A UI text of the locale file, `{name}` placeholders filled in. */
function message(locale: Locale, key: string, params: Record<string, string> = {}): string {
  let value: unknown = MESSAGES[locale];
  for (const part of key.split(".")) {
    value = (value as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof value !== "string") {
    throw new Error(`src/web/locales/${locale}.json has no ${key}`);
  }
  return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
}

function certificateId(name: string): string {
  const found = manifest.certificates.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`tests/fixtures/pki/manifest.json has no certificate ${name}`);
  }
  return found.sha256;
}

function pem(der: Uint8Array): string {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN X509 CRL-----\n${lines.join("\n")}\n-----END X509 CRL-----\n`;
}

interface Target {
  targetId: string;
  kind: "full" | "delta";
  label: string;
  issuer: { id: string };
  current: { summary: { crlNumber: string | null; revokedCount: number } } | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path}: ${res.status}`);
  }
  return (await res.json()) as T;
}

interface Seed {
  siteName: string;
  certificates: number;
  targets: number;
  issuing: { id: string; label: string };
  full: Target;
  upload: Target;
  firstUpload: boolean;
}

/** What `pnpm run seed:dev` left on the server, or why the run cannot start. */
async function readSeed(): Promise<Seed> {
  const html = await (await fetch(`${BASE}/`)).text();
  const siteName = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  if (siteName === undefined) {
    throw new Error("GET / has no <title> (is this the UI?)");
  }
  const certificates =
    await getJson<{ id: string; label: string | null }[]>("/api/v1/certificates");
  const targets = await getJson<Target[]>("/api/v1/crls");
  const issuingId = certificateId("issuing-ca-1");
  const issuing = certificates.find((each) => each.id === issuingId);
  const full = targets.find((each) => each.issuer.id === issuingId && each.kind === "full");
  const upload = targets.find(
    (each) => each.issuer.id === certificateId("issuing-ca-2") && each.kind === "delta"
  );
  if (
    issuing === undefined ||
    issuing.label === null ||
    full === undefined ||
    full.current === null ||
    upload === undefined
  ) {
    throw new Error(
      "the server is not seeded: AIA_URL=<base> AIA_ADMIN_TOKEN=<token> pnpm run seed:dev"
    );
  }
  return {
    siteName,
    certificates: certificates.length,
    targets: targets.length,
    issuing: { id: issuing.id, label: issuing.label },
    full,
    upload,
    firstUpload: upload.current === null,
  };
}

// Browser ----------------------------------------------------------------------------------------

function chromiumPath(): string {
  const configured = process.env.AIA_CHROMIUM;
  if (configured) {
    return configured;
  }
  const cache = join(homedir(), ".cache/ms-playwright");
  const revisions = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => name.startsWith("chromium_headless_shell-"))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const revision of revisions) {
    for (const platform of readdirSync(join(cache, revision))) {
      const binary = join(cache, revision, platform, "chrome-headless-shell");
      if (platform.startsWith("chrome-headless-shell-") && existsSync(binary)) {
        return binary;
      }
    }
  }
  throw new Error(
    "no headless Chromium: set AIA_CHROMIUM or run pnpm exec playwright-core install --only-shell chromium"
  );
}

/** Console and CSP findings of one browser context. */
interface Watch {
  problems: string[];
  violations: string[];
  /** Chrome's "Failed to load resource" lines that the running step expects. */
  expected: { url: string; status: number }[];
}

async function openContext(
  browser: Browser,
  locale: Locale,
  theme: Theme,
  width = 1280
): Promise<{ context: BrowserContext; watch: Watch }> {
  const context = await browser.newContext({
    baseURL: BASE,
    locale,
    colorScheme: theme,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  context.setDefaultTimeout(TIMEOUT_MS);
  const watch: Watch = { problems: [], violations: [], expected: [] };
  await context.exposeBinding("__aiaCspViolation", (_source, text: string) => {
    watch.violations.push(text);
  });
  // DevTools-injected, so the page's CSP does not apply to it.
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const blocked = event.blockedURI === "" ? "inline" : event.blockedURI;
      void window.__aiaCspViolation(
        `${event.effectiveDirective}: ${blocked} ` +
          `(${event.sourceFile}:${event.lineNumber}) ${event.sample}`
      );
    });
  });
  context.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") {
      return;
    }
    const text = msg.text();
    const { url } = msg.location();
    const index = watch.expected.findIndex(
      (each) =>
        url === `${BASE}${each.url}` &&
        text.startsWith(
          `Failed to load resource: the server responded with a status of ${each.status}`
        )
    );
    if (index >= 0) {
      watch.expected.splice(index, 1);
      return;
    }
    watch.problems.push(`console ${type}: ${text} (${url})`);
  });
  context.on("weberror", (error) => {
    watch.problems.push(`uncaught: ${error.error().message}`);
  });
  return { context, watch };
}

/** Waits for running CSS transitions and finite animations: tab highlight, accordion, toasts. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity
      )
  );
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (shotsArg !== undefined) {
    await settle(page);
    await page.screenshot({ path: join(shotsArg, `${name}.png`), fullPage: true });
  }
}

async function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

/** The theme the pre-paint script alone gives the page: the bundle is replaced by an empty one. */
async function prePaintTheme(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  await page.route("**/assets/*.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" })
  );
  try {
    await page.goto("/", { waitUntil: "load" });
    return await isDark(page);
  } finally {
    await page.close();
  }
}

async function heading(page: Page): Promise<string> {
  return (await page.locator("main h1").first().innerText()).trim();
}

// Steps ------------------------------------------------------------------------------------------

async function overview(page: Page, seed: Seed, locale: Locale, tag: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("certificate-table").waitFor();
  await page.getByTestId("crl-target-table").waitFor();
  await page.locator("[data-stat=attention] [data-testid=stat-value]").waitFor();
  const title = message(locale, "pages.overview.title");
  const certificates = await page.locator("[data-testid=certificate-table] tbody tr").count();
  const targets = await page.locator("[data-testid=crl-target-table] tbody tr").count();
  const stats = await page.locator("[data-testid=stat-value]").allInnerTexts();
  const health = await page.getByTestId("health-state").innerText();
  check(
    (await heading(page)) === title &&
      (await page.title()) === `${title} · ${seed.siteName}` &&
      (await page.getByTestId("site-name").innerText()).trim() === seed.siteName &&
      (await page.evaluate(() => document.documentElement.lang)) === locale,
    `${tag} overview: "${title} · ${seed.siteName}", <html lang="${locale}">`
  );
  check(
    certificates === seed.certificates &&
      targets === seed.targets &&
      stats.length === 5 &&
      stats[0]?.trim() === String(seed.certificates) &&
      /^\d+$/.test(stats[4]?.trim() ?? ""),
    `${tag} overview: ${certificates} certificates, ${targets} targets, stats ${stats.join(" / ")}`
  );
  check(
    health.trim() === message(locale, "health.state.healthy"),
    `${tag} health badge: ${health}`
  );
  await screenshot(page, `overview-${tag}`);
}

async function certificatePage(page: Page, seed: Seed, locale: Locale, tag: string): Promise<void> {
  const path = `/certificates/${seed.issuing.id}`;
  await page.goto(path);
  await page.locator("main h1").getByText(seed.issuing.label).waitFor();
  await page.reload();
  await page.locator("main h1").getByText(seed.issuing.label).waitFor();
  check(
    (await page.title()) === `${seed.issuing.label} · ${seed.siteName}`,
    `${tag} ${path} after a reload: ${await heading(page)}`
  );
  await screenshot(page, `certificate-${tag}`);

  const tabs = page.getByRole("tab");
  await tabs.nth(1).click();
  await settle(page);
  const background = (index: number) =>
    tabs.nth(index).evaluate((element: unknown) => getComputedStyle(element).backgroundColor);
  const [selected, other] = [await background(1), await background(0)];
  check(
    (await tabs.nth(1).getAttribute("data-state")) === "active" &&
      other === TRANSPARENT &&
      selected !== TRANSPARENT,
    `${tag} selected tab highlighted (${selected}; the others ${other})`
  );

  const item = page.locator(`[data-oid="${CA_VERSION}"]`);
  await item.getByRole("button").click();
  const content = item.locator("[data-slot=accordion-content]");
  await content.waitFor();
  const animation = await content.evaluate(
    (element: unknown) => getComputedStyle(element).animationName
  );
  await settle(page);
  // V0.0: certificate and key index 0.
  const text = (await content.innerText()).replace(/\s+/g, " ").trim();
  const want = ["certificateIndex", "keyIndex"].map(
    (field) => `${message(locale, `extension.fields.${field}`)} 0`
  );
  check(
    animation === "accordion-down" && want.every((row) => text.includes(row)),
    `${tag} CA Version opens (animation ${animation}): ${text}`
  );
  await screenshot(page, `certificate-extensions-${tag}`);
}

async function crlPage(page: Page, seed: Seed, tag: string): Promise<void> {
  const path = `/crls/${seed.full.targetId}`;
  await page.goto(path);
  await page.locator("main h1").getByText(seed.full.label).waitFor();
  await page.reload();
  await page.getByTestId("crl-overview").waitFor();
  check(
    (await heading(page)) === seed.full.label &&
      (await page.title()) === `${seed.full.label} · ${seed.siteName}`,
    `${tag} ${path} after a reload: ${await heading(page)}`
  );
  await screenshot(page, `crl-${tag}`);

  await page.getByRole("tab").nth(1).click();
  const rows = await page.locator("[data-testid=revoked-table] tbody tr").count();
  const revoked = seed.full.current?.summary.revokedCount;
  check(rows === revoked, `${tag} revoked list: ${rows} rows, the CRL has ${revoked}`);
  await screenshot(page, `crl-revoked-${tag}`);
}

/** Pastes `text`, submits and returns the upload response's status and body. */
async function upload(page: Page, text: string): Promise<{ status: number; body: unknown }> {
  await page.locator("[data-testid=upload-card] textarea").fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url() === `${BASE}/api/v1/crls` && res.request().method() === "POST"
    ),
    page.getByTestId("upload-submit").click(),
  ]);
  return { status: response.status(), body: (await response.json()) as unknown };
}

async function uploads(
  page: Page,
  seed: Seed,
  locale: Locale,
  tag: string,
  watch: Watch,
  first: boolean
): Promise<void> {
  await page.goto("/");
  await page.getByTestId("crl-target-table").waitFor();
  const newCrl = pem(fixture(NEW_CRL));
  const target = seed.upload.label;
  const outcomes = first ? ["created", "unchanged"] : ["unchanged"];
  for (const outcome of outcomes) {
    const { status, body } = await upload(page, newCrl);
    const alert = page.getByTestId("upload-success");
    await alert.waitFor();
    const want = message(locale, `upload.outcome.${outcome}`, { target });
    const shown = (await alert.locator("[data-slot=alert-title]").innerText()).trim();
    check(
      (body as { outcome?: unknown }).outcome === outcome && shown === want,
      `${tag} paste ${NEW_CRL} as PEM: ${status} ${outcome}, "${shown}"`
    );
  }

  watch.expected.push({ url: "/api/v1/crls", status: 409 });
  const { status, body } = await upload(page, new TextDecoder().decode(fixture(OLD_CRL)));
  const alert = page.locator("[data-testid=upload-error][data-code=stale_crl]");
  await alert.waitFor();
  const text = await alert.innerText();
  check(
    status === 409 &&
      (body as { error?: { code?: unknown } }).error?.code === "stale_crl" &&
      text.includes(message(locale, "upload.errors.uploadFailed")) &&
      text.includes(message(locale, "errors.stale_crl")),
    `${tag} paste ${OLD_CRL}: ${status} stale_crl, "${text.replace(/\s+/g, " ").trim()}"`
  );
  await screenshot(page, `upload-${tag}`);
  watch.expected.length = 0;
}

async function notFound(page: Page, locale: Locale, tag: string, watch: Watch): Promise<void> {
  const title = message(locale, "pages.notFound.title");
  for (const path of ["/no/such/page", "/certificates/0123ABC", "/crls/not-a-uuid"]) {
    const api: string[] = [];
    const listener = (request: { url: () => string }) => {
      if (request.url().startsWith(`${BASE}/api/v1/c`)) {
        api.push(request.url());
      }
    };
    page.on("request", listener);
    await page.goto(path);
    await page.getByTestId("not-found-page").waitFor();
    page.off("request", listener);
    check(
      (await heading(page)) === title && api.length === 0,
      `${tag} ${path}: "${title}", ${api.length} certificate / CRL API requests`
    );
  }

  const path = `/crls/${UNKNOWN_TARGET}`;
  watch.expected.push({ url: `/api/v1/crls/${UNKNOWN_TARGET}`, status: 404 });
  await page.goto(path);
  await page.getByTestId("missing").waitFor();
  const shown = await heading(page);
  check(shown === message(locale, "details.crl.notFoundTitle"), `${tag} ${path}: "${shown}"`);
  watch.expected.length = 0;
}

async function themeChoice(
  context: BrowserContext,
  page: Page,
  theme: Theme,
  tag: string
): Promise<void> {
  // The opposite of the colour scheme, so that only the stored choice can explain the result.
  const want: Theme = theme === "light" ? "dark" : "light";
  await page.goto("/");
  const toggle = page.locator("button[data-preference]");
  for (let i = 0; i < 3 && (await toggle.getAttribute("data-preference")) !== want; i += 1) {
    await toggle.click();
  }
  const chosen = await isDark(page);
  await page.reload();
  await page.getByTestId("site-name").waitFor();
  const reloaded = await isDark(page);
  const preference = await toggle.getAttribute("data-preference");
  const prePaint = await prePaintTheme(context);
  const dark = want === "dark";
  check(
    chosen === dark && reloaded === dark && prePaint === dark && preference === want,
    `${tag} theme ${want} chosen, kept after a reload (bundle: ${reloaded ? "dark" : "light"}, ` +
      `pre-paint script alone: ${prePaint ? "dark" : "light"})`
  );
}

function reportWatch(watch: Watch, tag: string): void {
  check(
    watch.problems.length === 0,
    `${tag} console: ${watch.problems.length === 0 ? "no errors or warnings" : watch.problems.join(" | ")}`
  );
  check(
    watch.violations.length === 0,
    `${tag} CSP: ${watch.violations.length === 0 ? "no violations" : watch.violations.join(" | ")}`
  );
}

async function run(browser: Browser, seed: Seed): Promise<void> {
  let first = seed.firstUpload;
  if (!first) {
    check(
      false,
      `${seed.upload.label} already has a CRL: the "created" upload needs a freshly seeded server`
    );
  }
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      const tag = `${locale}-${theme}`;
      const { context, watch } = await openContext(browser, locale, theme);
      await step(`${tag} pre-paint`, async () => {
        const dark = await prePaintTheme(context);
        check(
          dark === (theme === "dark"),
          `${tag} pre-paint script alone: ${dark ? "dark" : "light"}`
        );
      });
      const page = await context.newPage();
      await step(`${tag} overview`, () => overview(page, seed, locale, tag));
      await step(`${tag} certificate`, () => certificatePage(page, seed, locale, tag));
      await step(`${tag} CRL`, () => crlPage(page, seed, tag));
      await step(`${tag} upload`, () => uploads(page, seed, locale, tag, watch, first));
      first = false;
      await step(`${tag} not found`, () => notFound(page, locale, tag, watch));
      await step(`${tag} theme`, () => themeChoice(context, page, theme, tag));
      reportWatch(watch, tag);
      await context.close();
    }
  }

  const tag = "en-light-390";
  const { context, watch } = await openContext(browser, "en", "light", 390);
  const page = await context.newPage();
  await step(`${tag} overview`, async () => {
    await overview(page, seed, "en", tag);
    const [scrollWidth, innerWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    check(
      scrollWidth <= innerWidth,
      `${tag} no sideways page scroll (${scrollWidth} px content in ${innerWidth} px)`
    );
  });
  reportWatch(watch, tag);
  await context.close();
}

const seed = await readSeed().catch((error: unknown) => {
  console.error(`ui-smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
if (shotsArg !== undefined) {
  mkdirSync(shotsArg, { recursive: true });
}
const executablePath = chromiumPath();
console.log(`ui-smoke: ${BASE} with ${executablePath}`);
const browser = await chromium.launch({ executablePath });
try {
  await run(browser, seed);
} finally {
  await browser.close();
}
console.log(`ui-smoke: ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
