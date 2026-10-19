import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const DEFAULT_SITE_NAME = "PKI AIA/CDP";

// Paths owned by the Worker / Node server; the dev server proxies them to `wrangler dev` or
// `pnpm run dev:node` on 8787. String proxy keys are bare prefixes ("/crl" would also swallow the
// SPA route /crls/:targetId), so use one anchored RegExp key with trailing slashes. With
// root = src/web every folder under src/web is served at /<folder>/ in dev: never name one
// api, ca, crl or dcrl (the API client lives in src/web/client/).
const SERVER_PATHS = "^/(?:api|ca|crl|dcrl)/";

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
    plugins: [vue(), tailwindcss()],
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
