// The web build's own checks (vite.config.ts, implementation slice 5b steps 10–11), each run in a
// real `vite build` without writing anything: the server-code guard on probe modules placed in
// src/web (never on disk), so their imports resolve as the UI's do, and the CSP inline-script check
// on a small HTML page in a temporary directory. A last case pins that vite.config.ts runs both.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveConfig } from "vite";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cspInlineScriptCheck, serverCodeGuard } from "../../vite.config.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE = join(ROOT, "src/web/__server-code-probe__.ts");
const TIMEOUT = 30_000;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A module of the installed package `name` as the guard prints it (repository-relative). */
const installed = (name: string) => `node_modules/\\.pnpm/\\S+/node_modules/${escape(name)}/\\S+`;

/**
 * The guard's report line of one leaked module (`path` is a RegExp source) whose only importer is
 * the probe: the line itself, so a package named in another module's importers does not count.
 */
const leak = (path: string) =>
  new RegExp(`^  ${path} \\(imported by src/web/__server-code-probe__\\.ts\\)$`, "m");

/** The pre-paint theme script of src/web/index.html, tags included. */
const THEME_SCRIPT =
  /<script>[\s\S]*?<\/script>/.exec(readFileSync(join(ROOT, "src/web/index.html"), "utf8"))?.[0] ??
  "";

/** Serves `code` as the TypeScript module PROBE, the build's only entry. */
function probe(code: string): Plugin {
  return {
    name: "probe",
    enforce: "pre",
    resolveId: (id) => (id === PROBE ? PROBE : null),
    load: (id) => (id === PROBE ? code : null),
  };
}

function buildProbe(code: string) {
  return build({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    plugins: [probe(code), serverCodeGuard()],
    // Nothing is written, so the repository's dist/ is never emptied either.
    build: { write: false, emptyOutDir: false, rolldownOptions: { input: PROBE } },
  });
}

describe("server-code guard", () => {
  it(
    "lets type-only imports of server modules and hono/client through",
    async () => {
      // hono/client imports hono's cookie utilities itself: their importer is inside hono.
      const code = [
        'import { hc } from "hono/client";',
        'import type { Name } from "../core/summary/types.ts";',
        'import type { AppType } from "../http/app.ts";',
        "export const names: Name[] = [];",
        'export const api = hc<AppType>("");',
      ].join("\n");
      await expect(buildProbe(code)).resolves.toBeDefined();
    },
    TIMEOUT
  );

  it.each([
    ["src/core/catalog.ts", 'import { decodeJson } from "../core/catalog.ts";', "decodeJson"],
    [
      "src/http/csp.ts",
      'import { INLINE_SCRIPT_HASHES } from "../http/csp.ts";',
      "INLINE_SCRIPT_HASHES",
    ],
    ["src/storage/memory.ts", 'import { MemoryStore } from "../storage/memory.ts";', "MemoryStore"],
    [
      "src/runtime/settings.ts",
      'import { parseSettings } from "../runtime/settings.ts";',
      "parseSettings",
    ],
  ])(
    "fails on a runtime import of %s, naming it and its importer",
    async (path, line, name) => {
      const failed = buildProbe(`${line}\nexport const value = ${name};`);
      await expect(failed).rejects.toThrow(leak(escape(path)));
    },
    TIMEOUT
  );

  it(
    "names the importer of a dynamic import()",
    async () => {
      const failed = buildProbe('export const load = () => import("../core/digest.ts");');
      await expect(failed).rejects.toThrow(leak("src/core/digest\\.ts"));
    },
    TIMEOUT
  );

  it(
    "fails on an inline `import { type X }`, which survives as a side-effect import",
    async () => {
      const code =
        'import { type Name } from "../core/summary/types.ts";\nexport const n: Name[] = [];';
      await expect(buildProbe(code)).rejects.toThrow(leak("src/core/summary/types\\.ts"));
    },
    TIMEOUT
  );

  it.each([
    ["zod", 'import { z } from "zod";', "z.string()"],
    ["@hono/zod-openapi", 'import { z } from "@hono/zod-openapi";', "z.string()"],
    ["pkijs", 'import { Certificate } from "pkijs";', "Certificate"],
    ["asn1js", 'import { fromBER } from "asn1js";', "fromBER"],
    // Implementation §2.1: of hono, the web takes only hono/client at run time.
    ["hono", 'import { Hono } from "hono";', "new Hono()"],
    ["hono", 'import { secureHeaders } from "hono/secure-headers";', "secureHeaders()"],
    ["@hono/node-server", 'import { serve } from "@hono/node-server";', "serve"],
  ])(
    "fails on %s (%s)",
    async (name, line, use) => {
      await expect(buildProbe(`${line}\nexport const value = ${use};`)).rejects.toThrow(
        leak(installed(name))
      );
    },
    TIMEOUT
  );
});

describe("CSP inline-script check", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aia-cdp-csp-check-"));
    await writeFile(join(dir, "main.js"), "export const ui = 1;\n");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function buildPage(head: string) {
    const page =
      `<!doctype html><html><head>${head}</head>` +
      '<body><script type="module" src="./main.js"></script></body></html>';
    await writeFile(join(dir, "index.html"), page);
    return build({
      configFile: false,
      root: dir,
      logLevel: "silent",
      plugins: [cspInlineScriptCheck()],
      build: { write: false, emptyOutDir: false },
    });
  }

  it(
    "passes the pre-paint script of src/web/index.html and external scripts",
    async () => {
      expect(THEME_SCRIPT).toContain("theme-preference");
      await expect(buildPage(THEME_SCRIPT)).resolves.toBeDefined();
    },
    TIMEOUT
  );

  it.each([
    ["an unlisted inline script", "<script>document.title = 'x';</script>"],
    ["the pre-paint script with one byte changed", THEME_SCRIPT.replace('"dark"', '"Dark"')],
  ])(
    "fails on %s",
    async (_, head) => {
      await expect(buildPage(head)).rejects.toThrow("src/http/csp.ts");
    },
    TIMEOUT
  );
});

describe("vite.config.ts", () => {
  it(
    "runs both checks in its build",
    async () => {
      // The config writes the default site name back to process.env.
      const siteName = process.env.VITE_SITE_NAME;
      try {
        const config = await resolveConfig(
          { configFile: join(ROOT, "vite.config.ts"), logLevel: "silent" },
          "build"
        );
        expect(config.plugins.map((plugin) => plugin.name)).toEqual(
          expect.arrayContaining([serverCodeGuard().name, cspInlineScriptCheck().name])
        );
      } finally {
        if (siteName === undefined) {
          delete process.env.VITE_SITE_NAME;
        } else {
          process.env.VITE_SITE_NAME = siteName;
        }
      }
    },
    TIMEOUT
  );
});
