// typecheck:boundary (D9): fails when the Workers type program contains Node-only declarations.
// The three compiles and the tests/boundary canaries cannot see this: a dependency .d.ts with
// `/// <reference types="node" />` (vite, vitest, wrangler, ...) reached through any import, even
// `import type`, makes `process` and `Buffer` legal everywhere in that program.
import { execFileSync } from "node:child_process";
import process from "node:process";

const forbidden =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@types\/node|@hono\/node-server|vite|vitest|wrangler)\//;

const files = execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.worker.json", "--listFilesOnly"],
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean);
const leaks = files.filter((file) => forbidden.test(file));

if (leaks.length > 0) {
  console.error(
    `tsconfig.worker.json pulls in Node-only declarations (${leaks.length} files), e.g.:`
  );
  for (const file of leaks.slice(0, 5)) {
    console.error(`  ${file}`);
  }
  console.error(
    "Run `tsc -p tsconfig.worker.json --explainFiles` to see which import brings them in."
  );
  process.exitCode = 1;
} else {
  console.log(`tsconfig.worker.json: ${files.length} files, no Node-only declarations`);
}
