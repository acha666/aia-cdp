// node scripts/check-web-size.ts   (pnpm run size:web; ci:worker runs it after build:web)
//
// Size budget of the built UI (implementation slice 5b step 11, plan §8): dist/web/index.html and
// every dist/web/assets/*.js / *.css, each gzipped on its own (zlib.gzipSync at its default level;
// Vite's build report compresses differently and prints slightly larger numbers). Prints each file,
// the first screen (index.html and what it loads up front: its script, modulepreload and stylesheet
// references; marked *) and the total. Exits 1 when the total is over 250 000 bytes or index.html
// references a file that is not there, 2 without a build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET = 250_000;
const WEB = fileURLToPath(new URL("../dist/web/", import.meta.url));

interface Measured {
  file: string;
  raw: number;
  gzip: number;
}

function measure(file: string): Measured {
  const bytes = readFileSync(`${WEB}${file}`);
  return { file, raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];
}

/** The same-origin files index.html loads up front, as paths relative to dist/web. */
function firstScreen(html: string): string[] {
  const files: string[] = [];
  for (const [tag, name] of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const rel = attribute(tag, "rel")?.toLowerCase();
    const url =
      name?.toLowerCase() === "script"
        ? attribute(tag, "src")
        : rel === "stylesheet" || rel === "modulepreload"
          ? attribute(tag, "href")
          : undefined;
    if (url?.startsWith("/")) {
      files.push(url.slice(1));
    }
  }
  return files;
}

if (!existsSync(`${WEB}index.html`)) {
  console.error("size:web: dist/web/index.html is missing: run pnpm run build:web first");
  process.exit(2);
}

const assets = existsSync(`${WEB}assets`)
  ? readdirSync(`${WEB}assets`)
      .filter((name) => /\.(?:js|css)$/.test(name))
      .sort()
      .map((name) => `assets/${name}`)
  : [];
const files = ["index.html", ...assets].map(measure);
const upFront = new Set(["index.html", ...firstScreen(readFileSync(`${WEB}index.html`, "utf8"))]);

let failed = false;
for (const file of upFront) {
  if (!files.some((each) => each.file === file)) {
    console.error(`size:web: index.html references ${file}, which is not a built .js / .css file`);
    failed = true;
  }
}

const sum = (list: Measured[]) => list.reduce((total, each) => total + each.gzip, 0);
const pad = (value: number | string, width: number) => String(value).padStart(width);
console.log(`${pad("bytes", 9)} ${pad("gzip", 9)}  dist/web`);
for (const each of files) {
  const mark = upFront.has(each.file) ? " *" : "";
  console.log(`${pad(each.raw, 9)} ${pad(each.gzip, 9)}  ${each.file}${mark}`);
}
const first = sum(files.filter((each) => upFront.has(each.file)));
const total = sum(files);
console.log(`first screen (*): ${first} bytes gzip`);
console.log(
  `total: ${total} bytes gzip, budget ${BUDGET} (${Math.round((total / BUDGET) * 100)}%)`
);
if (total > BUDGET) {
  console.error(`size:web: ${total} bytes gzip is over the ${BUDGET}-byte budget`);
  failed = true;
}
process.exitCode = failed ? 1 : 0;
