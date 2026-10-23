// node scripts/generate-openapi.ts   (pnpm run openapi)
// Writes docs/openapi.json from the same route registry that serves GET /api/v1/openapi.json, with
// the same deps as tests/helpers/app.ts (MemoryStore, parseSettings({}) defaults);
// tests/http/openapi.test.ts fails when the committed file differs. src never imports
// docs/openapi.json (outside rootDir: src).
import { writeFileSync } from "node:fs";
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

writeFileSync(target, json);
process.stdout.write(`wrote docs/openapi.json (${generated})\n`);
