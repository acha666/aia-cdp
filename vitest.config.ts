import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));

// Standalone: vite.config.ts (root: src/web) is not merged when this file exists. Before every test,
// spies are restored and stubbed globals and env variables undone (both projects).
export default defineConfig({
  test: {
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/web/**"],
        },
      },
      {
        // Own Vite server (plugins / alias); the only project with a DOM.
        plugins: [vue()],
        resolve: { alias: { "@": webRoot } },
        // vite.config.ts's vue-i18n flags, so tests run the same vue-i18n features as the build.
        define: {
          __VUE_I18N_LEGACY_API__: false,
          __VUE_I18N_FULL_INSTALL__: false,
          __INTLIFY_PROD_DEVTOOLS__: false,
        },
        test: {
          name: "web",
          include: ["tests/web/**/*.test.ts"],
          environment: "happy-dom",
          env: { VITE_SITE_NAME: "Test PKI" },
          setupFiles: ["tests/web/setup.ts"],
        },
      },
    ],
  },
});
