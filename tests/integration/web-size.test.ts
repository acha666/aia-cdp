// scripts/check-web-size.ts (implementation slice 5b step 11) on small builds of its own in a
// temporary directory: the exit codes at and over the budget, for an index.html that references a
// missing file, and without a build; what counts as the first screen.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-web-size.ts", import.meta.url));
const BUDGET = 250_000;
const INDEX =
  '<!doctype html><html><head><script type="module" src="/assets/index.js"></script>' +
  '<link rel="stylesheet" href="/assets/index.css"></head><body></body></html>';
const SCRIPT_JS = "export const ui = 1;\n";
const STYLES = "body { margin: 0; }\n";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aia-cdp-web-size-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, dir], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      done({ code, stdout, stderr });
    });
  });
}

/** A built UI in `dir`: index.html and `assets` (file name → content). */
async function build(assets: Record<string, string | Uint8Array>, index = INDEX) {
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), index);
  for (const [name, content] of Object.entries(assets)) {
    await writeFile(join(dir, "assets", name), content);
  }
}

const gzip = (content: string | Uint8Array) => gzipSync(content).byteLength;

/** Random bytes (gzip cannot shrink them) that bring the build's gzip total to `total`. */
function filler(total: number): Uint8Array {
  const fixed = gzip(INDEX) + gzip(SCRIPT_JS) + gzip(STYLES);
  const random = randomBytes(BUDGET + 1000);
  let length = total - fixed;
  // Stored blocks: one byte more is one gzip byte more, apart from the block headers.
  for (let step = 0; step < 10; step += 1) {
    const missing = total - fixed - gzip(random.subarray(0, length));
    if (missing === 0) {
      return random.subarray(0, length);
    }
    length += missing;
  }
  throw new Error(`no filler for a total of ${String(total)}`);
}

describe("scripts/check-web-size.ts", () => {
  it("passes a build under the budget and counts what index.html loads as the first screen", async () => {
    await build({ "index.js": SCRIPT_JS, "index.css": STYLES, "lazy.js": "export {};\n" });

    const { code, stdout } = await run();
    expect(code).toBe(0);
    const first = gzip(INDEX) + gzip(SCRIPT_JS) + gzip(STYLES);
    expect(stdout).toContain(`first screen (*): ${String(first)} bytes gzip`);
    expect(stdout).toContain(`total: ${String(first + gzip("export {};\n"))} bytes gzip`);
    expect(stdout).toMatch(/ {2}assets\/index\.js \*\n/);
    expect(stdout).toMatch(/ {2}assets\/lazy\.js\n/);
  });

  it.each([
    [BUDGET, 0],
    [BUDGET + 1, 1],
  ])("exits for a total of %i bytes with %i", async (total, expected) => {
    await build({ "index.js": SCRIPT_JS, "index.css": STYLES, "lazy.js": filler(total) });

    const { code, stdout, stderr } = await run();
    expect(stdout).toContain(`total: ${String(total)} bytes gzip`);
    expect(code).toBe(expected);
    expect(stderr.includes("over the 250000-byte budget")).toBe(expected === 1);
  });

  it("exits 1 when index.html references a file the build does not have", async () => {
    await build({ "index.js": SCRIPT_JS });

    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("index.html references assets/index.css");
  });

  it("exits 2 without a build", async () => {
    const { code, stderr } = await run();
    expect(code).toBe(2);
    expect(stderr).toContain("index.html is missing");
  });
});
