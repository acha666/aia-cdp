// Smoke test of the Worker exactly as `wrangler deploy --dry-run --outdir dist/worker` built it,
// served in-process by wrangler's createTestHarness (random port, isolated storage), with
// scripts/smoke.sh. Part of `pnpm run ci:worker`, which builds dist/web and dist/worker first.
//
//   node scripts/worker-smoke.ts          (pnpm run smoke:worker)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Before wrangler is loaded: no telemetry, no banner or update check (implementation §2.4).
process.env.WRANGLER_SEND_METRICS = "false";
process.env.WRANGLER_HIDE_BANNER = "true";
const { createTestHarness } = await import("wrangler");

const root = fileURLToPath(new URL("..", import.meta.url));
for (const required of ["dist/worker/worker.js", "dist/web/index.html"]) {
  if (!existsSync(`${root}${required}`)) {
    console.error(
      `worker-smoke: ${required} is missing. Run pnpm run build:web && ` +
        "pnpm exec wrangler deploy --dry-run --outdir dist/worker (pnpm run ci:worker does both)."
    );
    process.exit(1);
  }
}

const server = createTestHarness({
  root,
  workers: [{ configPath: "./wrangler.jsonc", prebuiltWorkerDir: "./dist/worker" }],
});
let failed = false;
try {
  const { url } = await server.listen();
  console.log(`worker-smoke: dist/worker listening on ${url.origin}`);

  // Each harness gets fresh storage, so the configuration is always missing here.
  const res = await fetch(new URL("/api/v1/health", url));
  const body = await res.text();
  const degraded = res.status === 200 && body.includes('"status":"degraded"');
  console.log(`${degraded ? "ok  " : "FAIL"}  health is degraded: ${res.status} ${body}`);
  failed ||= !degraded;

  const smoke = spawnSync("bash", [`${root}scripts/smoke.sh`, url.origin], { stdio: "inherit" });
  failed ||= smoke.status !== 0;
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
