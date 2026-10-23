// node scripts/generate-openapi.ts [--check]
// Writes docs/openapi.json from the same route registry that serves GET /api/v1/openapi.json, with
// the same deps as tests/helpers/app.ts (MemoryStore, parseSettings({}) defaults). --check fails
// when the committed file differs byte for byte. Rewrite of worker-aia-cdp@5b570aa:scripts/
// generate-openapi.ts. src never imports docs/openapi.json (outside rootDir: src).
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createApp, OPENAPI_CONFIG } from "../src/http/app.ts";
import { parseSettings } from "../src/runtime/settings.ts";
import { MemoryStore } from "../src/storage/memory.ts";

const target = fileURLToPath(new URL("../docs/openapi.json", import.meta.url));

const settings = parseSettings({});
if (!settings.ok) {
  throw new Error(settings.error);
}
const app = createApp({
  store: new MemoryStore(),
  now: () => new Date(0),
  settings: settings.value.app,
  log: () => undefined,
});
// The time the runtime spends on the first GET /api/v1/openapi.json (slice 5a exit condition 9).
const started = performance.now();
const doc = app.getOpenAPI31Document(OPENAPI_CONFIG);
const generated = `generated in ${(performance.now() - started).toFixed(1)} ms`;
const json = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current: string | undefined;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== json) {
    process.stderr.write("docs/openapi.json is out of date: run `pnpm run openapi`\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`docs/openapi.json is up to date (${generated})\n`);
  }
} else {
  writeFileSync(target, json);
  process.stdout.write(`wrote docs/openapi.json (${generated})\n`);
}
