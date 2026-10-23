import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));

// Standalone: vite.config.ts (root: src/web) is not merged when this file exists.
export default defineConfig({
  test: {
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
        test: {
          name: "web",
          include: ["tests/web/**/*.test.ts"],
          environment: "happy-dom",
          env: { VITE_SITE_NAME: "Test PKI" },
        },
      },
    ],
  },
});
