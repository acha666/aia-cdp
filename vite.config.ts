import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, normalizePath } from "vite";
import type { Plugin } from "vite";
import { INLINE_SCRIPT_HASHES, inlineScriptHashes } from "./src/http/csp.ts";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const DEFAULT_SITE_NAME = "PKI AIA/CDP";

// Paths owned by the Worker / Node server; the dev server proxies them to `wrangler dev` or
// `pnpm run dev:node` on 8787. String proxy keys are bare prefixes ("/crl" would also swallow the
// SPA route /crls/:targetId), so use one anchored RegExp key with trailing slashes. With
// root = src/web every folder under src/web is served at /<folder>/ in dev: never name one
// api, ca, crl or dcrl (the API client lives in src/web/client/).
const SERVER_PATHS = "^/(?:api|ca|crl|dcrl)/";

/** Server code: the web graph may only `import type` from it (implementation §2.1). */
const SERVER_SOURCES = /^src\/(?:core|http|storage|runtime|cli)\//;
const SERVER_PACKAGES = /\/node_modules\/(?:zod|@hono\/zod-openapi|pkijs|asn1js)\//;
/** Hono and the @hono packages: of these, src/web may import only hono/client at run time. */
const HONO_PACKAGES = /\/node_modules\/(?:hono|@hono\/[^/]+)\//;
const HONO_CLIENT = "/node_modules/hono/dist/client/";

/**
 * Fails the build when the browser bundle's module graph reaches server code (slice 5b step 11,
 * implementation §2.1): a module under src/{core,http,storage,runtime,cli}/, zod,
 * @hono/zod-openapi, pkijs or asn1js from anywhere, or any hono / @hono module other than
 * hono/client that a src/web module imports (hono/client's own imports of hono's utilities have
 * importers inside hono and pass). Each leak is listed with its static and dynamic importers.
 * `import type` is erased before modules are resolved, so the types the web client takes from the
 * server never trip it.
 */
export function serverCodeGuard(): Plugin {
  // Repository-relative, without a query (`?vue&type=script`).
  const display = (id: string) => normalizePath(relative(repoRoot, id.split("?", 1)[0] ?? id));
  return {
    name: "aia-cdp:server-code-guard",
    apply: "build",
    buildEnd(error) {
      if (error) {
        return;
      }
      const leaks: string[] = [];
      for (const id of this.getModuleIds()) {
        const path = display(id);
        const module = normalizePath(id);
        const info = this.getModuleInfo(id);
        const importers = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])].map(
          display
        );
        const server = SERVER_SOURCES.test(path) || SERVER_PACKAGES.test(module);
        const hono =
          HONO_PACKAGES.test(module) &&
          !module.includes(HONO_CLIENT) &&
          importers.some((importer) => importer.startsWith("src/web/"));
        if (server || hono) {
          leaks.push(`  ${path} (imported by ${importers.join(", ") || "?"})`);
        }
      }
      if (leaks.length > 0) {
        this.error(
          "the web bundle reaches server code; import only types from it (`import type`), and " +
            `nothing of hono but hono/client:\n${leaks.join("\n")}`
        );
      }
    },
  };
}

/**
 * Fails the build when the built index.html carries an inline script that the CSP does not allow
 * by hash (src/http/csp.ts): the pre-paint theme script was changed without its hash, or a plugin
 * inlined a script of its own.
 */
export function cspInlineScriptCheck(): Plugin {
  return {
    name: "aia-cdp:csp-inline-script-check",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        const unlisted = (await inlineScriptHashes(html)).filter(
          (hash) => !INLINE_SCRIPT_HASHES.includes(hash)
        );
        if (unlisted.length > 0) {
          throw new Error(
            `index.html has inline scripts the CSP does not allow (${unlisted.join(", ")}): ` +
              "update INLINE_SCRIPT_HASHES in src/http/csp.ts with the script"
          );
        }
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  // SITE_NAME is build-time only: VITE_SITE_NAME from the process env (Docker ARG) or a repo-root
  // .env* file. Writing the default back to process.env makes both import.meta.env.VITE_SITE_NAME
  // and %VITE_SITE_NAME% in index.html resolve (Vite loads env after evaluating this function).
  const configured = loadEnv(mode, repoRoot, "VITE_").VITE_SITE_NAME ?? "";
  const siteName = configured === "" ? DEFAULT_SITE_NAME : configured;
  // %VITE_SITE_NAME% is substituted into index.html verbatim, without HTML escaping.
  if (/[<>&"]/.test(siteName)) {
    throw new Error(`VITE_SITE_NAME must not contain < > & or ": ${siteName}`);
  }
  process.env.VITE_SITE_NAME = siteName;

  return {
    root: webRoot,
    envDir: repoRoot,
    plugins: [vue(), tailwindcss(), serverCodeGuard(), cspInlineScriptCheck()],
    resolve: {
      alias: { "@": webRoot },
    },
    build: {
      outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      proxy: { [SERVER_PATHS]: "http://127.0.0.1:8787" },
    },
  };
});
