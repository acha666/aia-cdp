import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));

// Standalone: vite.config.ts (root: src/web) is not merged when this file exists. Inline projects
// inherit the root `test` options (vitest 5: `extends` defaults to true).
export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    // Generates tests/fixtures/pki once per run (idempotent; no pretest script).
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    projects: [
      { test: { name: "core", include: ["tests/core/**/*.test.ts"] } },
      { test: { name: "http", include: ["tests/http/**/*.test.ts"] } },
      { test: { name: "storage", include: ["tests/storage/**/*.test.ts"] } },
      { test: { name: "integration", include: ["tests/integration/**/*.test.ts"] } },
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
