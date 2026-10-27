// Shared by the web tests (not a test file itself): API bodies shaped by @/client/types with the
// facts of tests/fixtures/pki (ids, serials, validity, CRL numbers and times from manifest.json;
// subject names from the fixture generator; repeated bytes stand in for digests the manifest does
// not list), the fixtures' DER for the blob route, and a fetch stub that answers hc's requests by
// method and path.
import { VueQueryPlugin } from "@tanstack/vue-query";
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { DOMWrapper } from "@vue/test-utils";
import { onTestFinished, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import manifest from "../fixtures/pki/manifest.json";
import App from "@/App.vue";
import { createQueryClient } from "@/client/queries";
import type { CertificateListItem, CrlTargetListItem, PublishedCrl } from "@/client/types";
import { createAppI18n } from "@/i18n";
import { createAppRouter } from "@/router";

/** manifest.now: the clock of every test that depends on one. */
export const NOW = manifest.now;

/** The delta's id sorts first: only the UI's kind rule puts issuing-ca-1's full target first. */
export const TARGET_IDS = {
  issuingDelta: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405161",
  issuingFull: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405162",
  rootFull: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405164",
} as const;

type FixtureName = "root-ca" | "issuing-ca-1" | "issuing-ca-2";

const SUBJECT_CN: Record<FixtureName, string> = {
  "root-ca": "Example Root CA (ECC P-384)",
  "issuing-ca-1": "Example Issuing CA 01 (RSA)",
  "issuing-ca-2": "Example Issuing CA 02 (RSA)",
};

const fixtureCertificate = (name: FixtureName) =>
  manifest.certificates.find((certificate) => certificate.name === name)!;

const fixtureCrl = (file: string) => manifest.crls.find((crl) => crl.file === file)!;

/** The catalog's timestamp form (millisecond precision). */
function iso(value: string): string {
  return new Date(value).toISOString();
}

/** The fixtures' DER by path under tests/fixtures/pki, as data URLs (vitest.config.ts). */
const DER_URLS = import.meta.glob<string>("../fixtures/pki/**/*.der", {
  query: "?inline",
  import: "default",
  eager: true,
});

/** The bytes of the fixture `file` (e.g. "certs/root-ca.der"). */
export function der(file: string): Uint8Array<ArrayBuffer> {
  const url = DER_URLS[`../fixtures/pki/${file}`];
  if (url === undefined) {
    throw new Error(`no DER fixture ${file}`);
  }
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
}

/** The route of GET /api/v1/blobs/{sha256} answering with the fixture `file`. */
function blobRoute(sha256: string, file: string): Record<string, Handler> {
  return {
    [`GET /api/v1/blobs/${sha256}`]: () =>
      new Response(der(file), { headers: { "Content-Type": "application/octet-stream" } }),
  };
}

/** The blob route of a certificate fixture (certs/<name>.der). */
export const certificateBlob = (name: FixtureName) =>
  blobRoute(fixtureCertificate(name).sha256, `certs/${name}.der`);

/** The blob route of a CRL fixture (its manifest file). */
export const crlBlob = (file: string) => blobRoute(fixtureCrl(file).sha256, file);

export function certificateItem(
  name: FixtureName,
  overrides: Partial<CertificateListItem> = {}
): CertificateListItem {
  const fixture = fixtureCertificate(name);
  const issuerCN = SUBJECT_CN[fixture.issuer as FixtureName];
  return {
    id: fixture.sha256,
    label: null,
    importedAt: iso("2026-01-02T00:00:00Z"),
    size: 600,
    summary: {
      subjectCN: SUBJECT_CN[name],
      issuerCN,
      serialNumber: fixture.serial,
      notBefore: iso(fixture.notBefore),
      notAfter: iso(fixture.notAfter),
      subjectKeyId: "1a".repeat(20),
      authorityKeyId: "2b".repeat(20),
      sha1: "3c".repeat(20),
    },
    downloads: [`/ca/${name}.crt`, `/ca/${name}.crt.pem`],
    targets: [],
    ...overrides,
  } satisfies CertificateListItem;
}

/** The current CRL of a list item, from a manifest entry. */
export function currentOf(file: string) {
  const crl = fixtureCrl(file);
  return {
    sha256: crl.sha256,
    size: 400,
    publishedAt: iso("2026-01-03T12:00:00Z"),
    verifier: fixtureCertificate(crl.issuer as FixtureName).sha256,
    summary: {
      crlNumber: crl.crlNumber,
      baseCrlNumber: crl.baseCrlNumber,
      thisUpdate: iso(crl.thisUpdate),
      nextUpdate: crl.nextUpdate === null ? null : iso(crl.nextUpdate),
      revokedCount: crl.revoked,
      sha1: "6f".repeat(20),
      nextPublish: crl.nextPublish === null ? null : iso(crl.nextPublish),
    },
  };
}

const ISSUING = certificateItem("issuing-ca-1");
const ROOT = certificateItem("root-ca");

/**
 * The three targets of the page tests in the API's order (by targetId): issuing-ca-1
 * delta (unpublished) and full (full-adcs, current until its Next CRL Publish), root-ca full
 * (full-01).
 */
export function targetItems(): CrlTargetListItem[] {
  return [
    {
      targetId: TARGET_IDS.issuingDelta,
      kind: "delta",
      label: "Issuing CA 01",
      issuer: { id: ISSUING.id, label: null, subjectCN: SUBJECT_CN["issuing-ca-1"] },
      downloads: ["/dcrl/ca01.crl", "/dcrl/ca01.crl.pem"],
      current: null,
    },
    {
      targetId: TARGET_IDS.issuingFull,
      kind: "full",
      label: "Issuing CA 01",
      issuer: { id: ISSUING.id, label: null, subjectCN: SUBJECT_CN["issuing-ca-1"] },
      downloads: ["/crl/ca01.crl", "/crl/ca01.crl.pem"],
      current: currentOf("crls/issuing-ca-1/full-adcs.der"),
    },
    {
      targetId: TARGET_IDS.rootFull,
      kind: "full",
      label: "Root CA",
      issuer: { id: ROOT.id, label: "Root", subjectCN: SUBJECT_CN["root-ca"] },
      downloads: ["/crl/root.crl", "/crl/root.crl.pem"],
      current: currentOf("crls/root-ca/full-01.der"),
    },
  ] satisfies CrlTargetListItem[];
}

/** The 201 / 200 body of an upload to issuing-ca-1's full target (full-02). */
export function publishedCrl(outcome: PublishedCrl["outcome"]): PublishedCrl {
  const crl = fixtureCrl("crls/issuing-ca-1/full-02.der");
  return {
    outcome,
    target: TARGET_IDS.issuingFull,
    kind: "full",
    sha256: crl.sha256,
    crlNumber: crl.crlNumber,
    baseCrlNumber: null,
    thisUpdate: iso(crl.thisUpdate),
    nextUpdate: crl.nextUpdate === null ? null : iso(crl.nextUpdate),
    issuer: ISSUING.id,
    downloads: ["/crl/ca01.crl", "/crl/ca01.crl.pem"],
  } satisfies PublishedCrl;
}

// Mounting -------------------------------------------------------------------------------------------

/**
 * The app's QueryClient (createQueryClient, so its retry rule applies) with retries that do not
 * wait: a retry still needs a timer turn, so a case that expects one waits for it (vi.waitFor).
 * Cleared when the test finishes.
 */
export function testQueryClient(): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  onTestFinished(() => client.clear());
  return client;
}

/**
 * The whole app at `path` (memory history, en) with testQueryClient(); resolves once the lazy
 * route component is loaded and the first answers are rendered.
 */
export async function mountApp(path: string) {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  const queryClient = testQueryClient();
  const wrapper = mount(App, {
    global: { plugins: [router, createAppI18n("en"), [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return { router, wrapper, queryClient };
}

/** The [term, value] pairs of the description lists in `element`. */
export function definitions(element: Pick<DOMWrapper<Element>, "findAll">): [string, string][] {
  const values = element.findAll("dd");
  return element.findAll("dt").map((term, index) => [term.text(), values[index]!.text()]);
}

// Fetch ------------------------------------------------------------------------------------------

/** A v1 error envelope. */
export function envelope(status: number, code: string, details?: unknown): Response {
  return Response.json(
    { error: { code, message: `${code} (test)`, ...(details === undefined ? {} : { details }) } },
    { status }
  );
}

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs the global fetch: `routes` maps "GET /api/v1/crls" (method, space, path) to a handler. The
 * health check answers healthy unless routed; anything else is a 404 envelope, so a test sees an
 * unexpected request in `calls` rather than a hang.
 */
export function stubApi(routes: Record<string, Handler | undefined>) {
  const keyOf = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), "http://test");
    return `${init?.method ?? "GET"} ${url.pathname}`;
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = keyOf(input, init);
    const handler = routes[key];
    if (handler !== undefined) {
      return handler(init);
    }
    if (key === "GET /api/v1/health") {
      return Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } });
    }
    return envelope(404, "not_found");
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /** "METHOD /path" of every request except the health check, in order. */
    calls: () =>
      fetchMock.mock.calls
        .map(([input, init]) => keyOf(input, init))
        .filter((call) => call !== "GET /api/v1/health"),
  };
}
