// Smoke test of the Worker exactly as `wrangler deploy --dry-run --outdir dist/worker` built it,
// served in-process by wrangler's createTestHarness (random port, isolated storage): health
// "degraded" on the empty store, scripts/smoke.sh, then the download segment (implementation
// slice 3). Part of `pnpm run ci:worker`, which builds dist/web and dist/worker first.
//
//   node scripts/worker-smoke.ts          (pnpm run smoke:worker)
//
// The download segment imports certs/root-ca.der and applies a configuration serving it under
// /ca/root-ca.crt through the admin API (the token is a harness secret), expects health "healthy",
// then checks GET / HEAD / If-None-Match 304 / text 405 on that path and its .pem against
// tests/helpers/runtime-downloads.ts, the values tests/integration/downloads.test.ts expects of
// Node, and that an unconfigured /crl/x.crl is the text 404, not index.html. Each compared header
// is also printed as `download-header <METHOD> <path> <Name>: <value>`. Only headers are checked
// for HEAD and 304: fetch never surfaces a body for them, whatever the server sends, and workerd
// keeps a raw socket open past `Connection: close`. That nothing follows the header block on the
// wire is checked on Node (tests/integration/downloads.test.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMPARED_HEADERS,
  comparedHeaders,
  ROOT_CA_PATH,
  rootCaCertificate,
  rootCaDownloads,
  sha256Of,
} from "../tests/helpers/runtime-downloads.ts";

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

// Fresh for every run and never printed; letters, digits and `-` satisfy the b64token rule.
const ADMIN_TOKEN = `smoke-${randomBytes(16).toString("hex")}`;

let failed = false;

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${description}`);
  failed ||= !ok;
}

/** Every header but Date, as one comparable string. */
function headerBlock(res: Response): string {
  return JSON.stringify([...res.headers].filter(([name]) => name !== "date"));
}

async function health(base: URL, status: "degraded" | "healthy"): Promise<void> {
  const res = await fetch(new URL("/api/v1/health", base));
  const body = await res.text();
  check(
    res.status === 200 && body.includes(`"status":"${status}"`),
    `health is ${status}: ${res.status} ${body}`
  );
}

async function admin(base: URL, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ADMIN_TOKEN}`);
  return fetch(new URL(path, base), { ...init, headers });
}

async function downloadSegment(base: URL): Promise<void> {
  const { der, id } = rootCaCertificate();
  const imported = await admin(base, "/api/v1/admin/certificates", {
    method: "POST",
    headers: { "Content-Type": "application/pkix-cert" },
    body: der,
  });
  const importBody = await imported.text();
  check(
    imported.status === 201,
    `import certs/root-ca.der: ${imported.status}${imported.status === 201 ? "" : ` ${importBody}`}`
  );

  const config = {
    version: 1,
    certificates: { [id]: { label: "Root CA" } },
    targets: {},
    paths: { [ROOT_CA_PATH]: { certificate: id } },
  };
  const applied = await admin(base, "/api/v1/admin/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-None-Match": "*" },
    body: JSON.stringify(config),
  });
  const appliedBody = await applied.text();
  check(
    applied.status === 200,
    `apply a config serving ${ROOT_CA_PATH}: ${applied.status} ` +
      `${applied.status === 200 ? `(ETag ${applied.headers.get("ETag")})` : appliedBody}`
  );
  await health(base, "healthy");

  for (const expected of rootCaDownloads()) {
    const url = new URL(expected.path, base);
    const want = JSON.stringify(expected.headers);
    const get = await fetch(url);
    const head = await fetch(url, { method: "HEAD" });
    for (const [method, res] of [
      ["GET", get],
      ["HEAD", head],
    ] as const) {
      for (const name of COMPARED_HEADERS) {
        console.log(`download-header ${method} ${expected.path} ${name}: ${res.headers.get(name)}`);
      }
      const got = JSON.stringify(comparedHeaders((name) => res.headers.get(name)));
      const ok = res.status === 200 && got === want;
      check(
        ok,
        `${method} ${expected.path}: ${res.status}, ${ok ? "the expected" : `${got}, not the`} ` +
          `${COMPARED_HEADERS.join(", ")}`
      );
    }
    const digest = sha256Of(new Uint8Array(await get.arrayBuffer()));
    check(digest === expected.bodySha256, `GET ${expected.path}: body sha256 ${digest}`);
    // Releases the connection; fetch shows an empty body for HEAD and 304 in any case.
    await head.arrayBuffer();
    check(headerBlock(head) === headerBlock(get), `HEAD ${expected.path}: the GET headers`);

    for (const method of ["GET", "HEAD"]) {
      const res = await fetch(url, {
        method,
        headers: { "If-None-Match": expected.headers.ETag },
      });
      await res.arrayBuffer();
      check(
        res.status === 304 &&
          res.headers.get("ETag") === expected.headers.ETag &&
          res.headers.get("Cache-Control") === expected.headers["Cache-Control"] &&
          res.headers.get("Content-Length") === null &&
          res.headers.get("Content-Type") === null,
        `${method} ${expected.path} (If-None-Match: its ETag): ${res.status} with ETag and ` +
          "Cache-Control only"
      );
    }

    const post = await fetch(url, { method: "POST" });
    const postBody = await post.text();
    check(
      post.status === 405 &&
        post.headers.get("Allow") === "GET, HEAD" &&
        (post.headers.get("Content-Type") ?? "").startsWith("text/plain") &&
        postBody === "Method Not Allowed",
      `POST ${expected.path}: ${post.status} Allow: ${post.headers.get("Allow")} ${postBody}`
    );
  }

  // Configured now, but not this path: still the download prefix's text 404, not the SPA.
  const miss = await fetch(new URL("/crl/x.crl", base));
  const missBody = await miss.text();
  const type = miss.headers.get("Content-Type") ?? "";
  check(
    miss.status === 404 && type.startsWith("text/plain") && missBody === "Not Found",
    `GET /crl/x.crl: ${miss.status} ${type} ${JSON.stringify(missBody.slice(0, 40))}`
  );
}

const server = createTestHarness({
  root,
  workers: [
    {
      configPath: "./wrangler.jsonc",
      prebuiltWorkerDir: "./dist/worker",
      secrets: { AIA_ADMIN_TOKEN: ADMIN_TOKEN },
    },
  ],
});
try {
  const { url } = await server.listen();
  console.log(`worker-smoke: dist/worker listening on ${url.origin}`);

  // Each harness gets fresh storage, so the configuration is always missing here.
  await health(url, "degraded");

  // Not spawnSync: a blocked event loop never sees workerd close the idle keep-alive connection
  // of the health request, and the next fetch would be sent on it ("other side closed").
  const smoke = spawn("bash", [`${root}scripts/smoke.sh`, url.origin], { stdio: "inherit" });
  const [code] = (await once(smoke, "close")) as [number | null];
  check(code === 0, `scripts/smoke.sh ${url.origin}`);

  console.log("worker-smoke: downloads");
  await downloadSegment(url);
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
