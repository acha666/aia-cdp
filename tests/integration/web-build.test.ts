// The web build's own checks (vite.config.ts, implementation slice 5b steps 10–11), each run in a
// real `vite build` without writing anything: the server-code guard on probe modules placed in
// src/web (never on disk), so their imports resolve as the UI's do, and the CSP inline-script check
// on a small HTML page in a temporary directory.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cspInlineScriptCheck, serverCodeGuard } from "../../vite.config.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE = join(ROOT, "src/web/__server-code-probe__.ts");
const TIMEOUT = 30_000;
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
  ])(
    "fails on a runtime import of %s, naming it and its importer",
    async (path, line, name) => {
      const failed = buildProbe(`${line}\nexport const value = ${name};`);
      await expect(failed).rejects.toThrow(path);
      await expect(failed).rejects.toThrow("src/web/__server-code-probe__.ts");
    },
    TIMEOUT
  );

  it(
    "fails on an inline `import { type X }`, which survives as a side-effect import",
    async () => {
      const code =
        'import { type Name } from "../core/summary/types.ts";\nexport const n: Name[] = [];';
      await expect(buildProbe(code)).rejects.toThrow("src/core/summary/types.ts");
    },
    TIMEOUT
  );

  it.each([
    ["zod", 'import { z } from "zod";', "z.string()"],
    ["@hono/zod-openapi", 'import { z } from "@hono/zod-openapi";', "z.string()"],
    ["pkijs", 'import { Certificate } from "pkijs";', "Certificate"],
    ["asn1js", 'import { fromBER } from "asn1js";', "fromBER"],
  ])(
    "fails on %s",
    async (name, line, use) => {
      await expect(buildProbe(`${line}\nexport const value = ${use};`)).rejects.toThrow(
        `/node_modules/${name}/`
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
