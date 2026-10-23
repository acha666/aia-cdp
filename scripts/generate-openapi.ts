// node scripts/generate-openapi.ts   (pnpm run openapi)
// Writes docs/openapi.json from the same route registry that serves GET /api/v1/openapi.json, on
// the deps tests/http/openapi.test.ts uses too (tests/helpers/app.ts testDeps()); that test fails
// when the committed file differs. src never imports docs/openapi.json (outside rootDir: src).
import { writeFileSync } from "node:fs";
import process from "node:process";
import { createApp, OPENAPI_CONFIG } from "../src/http/app.ts";
import { testDeps } from "../tests/helpers/app.ts";

const doc = createApp(testDeps()).getOpenAPI31Document(OPENAPI_CONFIG);
writeFileSync(
  new URL("../docs/openapi.json", import.meta.url),
  `${JSON.stringify(doc, null, 2)}\n`
);
process.stdout.write("wrote docs/openapi.json\n");
