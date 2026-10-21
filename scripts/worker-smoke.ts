// Smoke test of the Worker exactly as `wrangler deploy --dry-run --outdir dist/worker` built it,
// served in-process by wrangler's createTestHarness (random port, isolated storage): health
// "degraded" on the empty store, scripts/smoke.sh, then the download segment (implementation
// slice 3), the publish segment (slice 4) and the read segment (slice 5a). Part of
// `pnpm run ci:worker`, which builds dist/web and dist/worker first.
//
//   node scripts/worker-smoke.ts          (pnpm run smoke:worker)
//
// The download segment imports certs/root-ca.der and certs/issuing-ca-1.der and applies a
// configuration serving the root under /ca/root-ca.crt, with full CRL targets of both CAs under
// /crl/root-ca.crl and /crl/issuing-ca-1.crl, through the admin API (both tokens are harness
// secrets), expects health "healthy", then checks GET / HEAD / If-None-Match 304 / text 405 on the
// certificate path and its .pem against tests/helpers/runtime-downloads.ts, the values
// tests/integration/downloads.test.ts expects of Node, and that an unconfigured /crl/x.crl is the
// text 404, not index.html. Each compared header is also printed as
// `download-header <METHOD> <path> <Name>: <value>`. Only headers are checked for HEAD and 304:
// fetch never surfaces a body for them, whatever the server sends, and workerd keeps a raw socket
// open past `Connection: close`. That nothing follows the header block on the wire is checked on
// Node (tests/integration/downloads.test.ts).
//
// The publish segment sends CRLs through POST /api/v1/crls so that signature verification runs on
// workerd's WebCrypto, not only Node's: ECDSA P-384 (root-ca), RSA PKCS#1 v1.5, RSASSA-PSS and
// SHA-1 (issuing-ca-1), and a broken RSA signature (422 invalid_signature); raw and multipart
// bodies (workerd parses the form), the upload token (401 without it). Then the same download
// checks on /crl/root-ca.crl and its .pem: workerd runs on the real clock, so crls/root-ca/full-01
// is past its nextUpdate and gets max-age=60.
//
// The read segment GETs the public read routes on what the two segments before it left, so that
// the detail builders (PKIjs, WebCrypto SHA-1 / SHA-256 fingerprints, the ECDSA (r, s) decoding)
// run on workerd too: both lists, a certificate detail by an uppercase id, issuing-ca-1's target
// detail (its current CRL is crls/issuing-ca-1/full-sha1), the stats, and HEAD of each.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixture, manifest } from "../tests/fixtures/pki.ts";
import {
  COMPARED_HEADERS,
  comparedHeaders,
  ROOT_CA_CRL,
  ROOT_CA_CRL_PATH,
  ROOT_CA_PATH,
  rootCaCertificate,
  rootCaCrlDownloads,
  rootCaDownloads,
  sha256Of,
} from "../tests/helpers/runtime-downloads.ts";
import type { RuntimeDownload } from "../tests/helpers/runtime-downloads.ts";

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
const UPLOAD_TOKEN = `smoke-upload-${randomBytes(16).toString("hex")}`;

const ISSUING_CA_CRL_PATH = "/crl/issuing-ca-1.crl";

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

/** A certificate fixture's DER and id (the SHA-256 of the DER), for an import. */
function certificate(name: string): { der: Uint8Array<ArrayBuffer>; id: string } {
  const entry = manifest.certificates.find((each) => each.name === name);
  if (entry === undefined) {
    throw new Error(`tests/fixtures/pki/manifest.json has no certificate ${name}`);
  }
  const der = fixture(entry.der);
  return { der, id: sha256Of(der) };
}

async function importCertificate(base: URL, name: string): Promise<void> {
  const res = await admin(base, "/api/v1/admin/certificates", {
    method: "POST",
    headers: { "Content-Type": "application/pkix-cert" },
    body: certificate(name).der,
  });
  const body = await res.text();
  check(
    res.status === 201,
    `import certs/${name}.der: ${res.status}${res.status === 201 ? "" : ` ${body}`}`
  );
}

/** GET / HEAD / If-None-Match 304 / text 405 of each download against its expected values. */
async function checkDownloads(base: URL, downloads: RuntimeDownload[]): Promise<void> {
  for (const expected of downloads) {
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
}

/** The target ids of the configuration the download segment applies. */
interface Targets {
  root: string;
  issuing: string;
}

async function downloadSegment(base: URL): Promise<Targets> {
  await importCertificate(base, "root-ca");
  await importCertificate(base, "issuing-ca-1");

  const { id } = rootCaCertificate();
  const targets: Targets = { root: crypto.randomUUID(), issuing: crypto.randomUUID() };
  const config = {
    version: 1,
    certificates: { [id]: { label: "Root CA" } },
    targets: {
      [targets.root]: { issuer: id, kind: "full", label: "Root CA" },
      [targets.issuing]: {
        issuer: certificate("issuing-ca-1").id,
        kind: "full",
        label: "Issuing CA 1",
      },
    },
    paths: {
      [ROOT_CA_PATH]: { certificate: id },
      [ROOT_CA_CRL_PATH]: { target: targets.root },
      [ISSUING_CA_CRL_PATH]: { target: targets.issuing },
    },
  };
  const applied = await admin(base, "/api/v1/admin/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-None-Match": "*" },
    body: JSON.stringify(config),
  });
  const appliedBody = await applied.text();
  check(
    applied.status === 200,
    `apply a config serving ${ROOT_CA_PATH}, ${ROOT_CA_CRL_PATH} and ${ISSUING_CA_CRL_PATH}: ` +
      `${applied.status} ` +
      `${applied.status === 200 ? `(ETag ${applied.headers.get("ETag")})` : appliedBody}`
  );
  await health(base, "healthy");

  await checkDownloads(base, rootCaDownloads());

  // Configured now, but not this path: still the download prefix's text 404, not the SPA.
  const miss = await fetch(new URL("/crl/x.crl", base));
  const missBody = await miss.text();
  const type = miss.headers.get("Content-Type") ?? "";
  check(
    miss.status === 404 && type.startsWith("text/plain") && missBody === "Not Found",
    `GET /crl/x.crl: ${miss.status} ${type} ${JSON.stringify(missBody.slice(0, 40))}`
  );
  return targets;
}

// Publish ----------------------------------------------------------------------------------------

interface Upload {
  file: string;
  /** How the CRL is sent: a raw DER body, or the field crl of a multipart form. */
  as: "raw" | "file field" | "string field";
  target: keyof Targets;
  status: 200 | 201 | 422;
  /** outcome for 200 / 201, error.code for 422. */
  result: string;
}

// In order: each row expects the state the rows before it left.
const UPLOADS: Upload[] = [
  // ECDSA P-384 with SHA-384.
  { file: ROOT_CA_CRL, as: "raw", target: "root", status: 201, result: "created" },
  { file: ROOT_CA_CRL, as: "file field", target: "root", status: 200, result: "unchanged" },
  {
    file: "crls/root-ca/full-01.pem",
    as: "string field",
    target: "root",
    status: 200,
    result: "unchanged",
  },
  // RSA PKCS#1 v1.5 with SHA-256, then RSASSA-PSS and SHA-1 with higher CRL Numbers.
  {
    file: "crls/issuing-ca-1/full-01.der",
    as: "raw",
    target: "issuing",
    status: 201,
    result: "created",
  },
  {
    file: "crls/issuing-ca-1/full-pss.der",
    as: "raw",
    target: "issuing",
    status: 200,
    result: "updated",
  },
  {
    file: "crls/issuing-ca-1/full-sha1.der",
    as: "raw",
    target: "issuing",
    status: 200,
    result: "updated",
  },
  {
    file: "crls/issuing-ca-1/full-broken-sig.der",
    as: "raw",
    target: "issuing",
    status: 422,
    result: "invalid_signature",
  },
];

function uploadInit(upload: Upload): RequestInit {
  const bytes = fixture(upload.file);
  const headers = new Headers({ Authorization: `Bearer ${UPLOAD_TOKEN}` });
  if (upload.as === "raw") {
    headers.set("Content-Type", "application/pkix-crl");
    return { method: "POST", headers, body: bytes };
  }
  const form = new FormData();
  if (upload.as === "file field") {
    form.append("crl", new Blob([bytes]), "upload.crl");
  } else {
    form.append("crl", new TextDecoder().decode(bytes));
  }
  return { method: "POST", headers, body: form };
}

/** The manifest digest of a CRL fixture (a .pem stands for its .der). */
function crlSha256(file: string): string | undefined {
  const der = file.replace(/\.pem$/, ".der");
  return manifest.crls.find((crl) => crl.file === der)?.sha256;
}

async function publishSegment(base: URL, targets: Targets): Promise<void> {
  const url = new URL("/api/v1/crls", base);
  const anonymous = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pkix-crl" },
    body: fixture(ROOT_CA_CRL),
  });
  await anonymous.arrayBuffer();
  check(
    anonymous.status === 401 && anonymous.headers.get("WWW-Authenticate") !== null,
    `POST /api/v1/crls without the upload token: ${anonymous.status} WWW-Authenticate: ` +
      `${anonymous.headers.get("WWW-Authenticate")}`
  );

  for (const upload of UPLOADS) {
    const res = await fetch(url, uploadInit(upload));
    const text = await res.text();
    let body: { outcome?: unknown; target?: unknown; sha256?: unknown; error?: { code?: unknown } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = {};
    }
    const ok =
      res.status === upload.status &&
      res.headers.get("Cache-Control") === "no-store" &&
      (upload.status === 422
        ? body.error?.code === upload.result
        : body.outcome === upload.result &&
          body.target === targets[upload.target] &&
          body.sha256 === crlSha256(upload.file));
    check(
      ok,
      `POST /api/v1/crls ${upload.file} (${upload.as}): ${res.status} ` +
        `${ok ? upload.result : text.slice(0, 300)}`
    );
  }

  await checkDownloads(base, rootCaCrlDownloads(new Date()));
}

// Reads ------------------------------------------------------------------------------------------

/** A read route: ok (200 and no-store), status, text and JSON body (null when not JSON). */
async function read(base: URL, path: string, method = "GET") {
  const res = await fetch(new URL(path, base), { method });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Reported by the caller's check.
  }
  const noStore = res.headers.get("Cache-Control") === "no-store";
  return { ok: res.status === 200 && noStore, status: res.status, text, body };
}

/** The manifest entry of a CRL fixture. */
function crlFixture(file: string) {
  const entry = manifest.crls.find((crl) => crl.file === file);
  if (entry === undefined) {
    throw new Error(`tests/fixtures/pki/manifest.json has no CRL ${file}`);
  }
  return entry;
}

async function readSegment(base: URL, targets: Targets): Promise<void> {
  const root = certificate("root-ca");
  const rootSerial = manifest.certificates.find((each) => each.name === "root-ca")?.serial;
  const issuing = certificate("issuing-ca-1");
  const issuingCrl = crlFixture("crls/issuing-ca-1/full-sha1.der");
  const rootCrl = crlFixture(ROOT_CA_CRL);
  const show = (text: string) => text.slice(0, 300);

  const certificates = await read(base, "/api/v1/certificates");
  const ids = (certificates.body as { id?: unknown }[] | null)?.map((item) => item.id);
  check(
    certificates.ok && JSON.stringify(ids) === JSON.stringify([root.id, issuing.id].sort()),
    `GET /api/v1/certificates: ${certificates.status} ${show(JSON.stringify(ids))}`
  );

  const path = `/api/v1/certificates/${root.id.toUpperCase()}`;
  const detail = await read(base, path);
  const certificateBody = detail.body as {
    id?: unknown;
    fingerprints?: { sha256?: unknown };
    tbsCertificate?: { serialNumber?: { hex?: unknown } };
    signatureValue?: { parsed?: { type?: unknown } };
  } | null;
  check(
    detail.ok &&
      certificateBody?.id === root.id &&
      certificateBody.fingerprints?.sha256 === root.id &&
      certificateBody.tbsCertificate?.serialNumber?.hex === rootSerial &&
      certificateBody.signatureValue?.parsed?.type === "ecdsa",
    `GET ${path}: ${detail.status} ${detail.ok ? "the root's detail, ECDSA (r, s)" : show(detail.text)}`
  );

  const crls = await read(base, "/api/v1/crls");
  const items = (crls.body ?? []) as { targetId?: string; current?: { sha256?: unknown } | null }[];
  const currents = items.map((item) => [item.targetId, item.current?.sha256 ?? null]);
  const want = [
    [targets.root, rootCrl.sha256],
    [targets.issuing, issuingCrl.sha256],
  ].sort(([a = ""], [b = ""]) => (a < b ? -1 : 1));
  check(
    crls.ok && JSON.stringify(currents) === JSON.stringify(want),
    `GET /api/v1/crls: ${crls.status} ${show(JSON.stringify(currents))}`
  );

  const targetPath = `/api/v1/crls/${targets.issuing}`;
  const target = await read(base, targetPath);
  const current = (
    target.body as {
      current?: {
        sha256?: unknown;
        summary?: { revokedCount?: unknown };
        tbsCertList?: { revokedCertificates?: { count?: unknown; items?: unknown[] } };
        signatureAlgorithm?: { algorithm?: { name?: unknown } };
      } | null;
    } | null
  )?.current;
  const revoked = current?.tbsCertList?.revokedCertificates;
  check(
    target.ok &&
      current?.sha256 === issuingCrl.sha256 &&
      revoked?.count === issuingCrl.revoked &&
      revoked.items?.length === issuingCrl.revoked &&
      current.summary?.revokedCount === issuingCrl.revoked &&
      current.signatureAlgorithm?.algorithm?.name === "sha1WithRSAEncryption",
    `GET ${targetPath}: ${target.status} ` +
      `${target.ok ? `${issuingCrl.file}, ${issuingCrl.revoked} entries` : show(target.text)}`
  );

  const derBytes = [root.der, issuing.der, fixture(ROOT_CA_CRL), fixture(issuingCrl.file)].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0
  );
  const expected = {
    certificates: 2,
    targets: { full: 2, delta: 0 },
    published: { full: 2, delta: 0 },
    totalRevocations: rootCrl.revoked + issuingCrl.revoked,
    derBytes,
  };
  const stats = await read(base, "/api/v1/stats");
  check(
    stats.ok && JSON.stringify(stats.body) === JSON.stringify(expected),
    `GET /api/v1/stats: ${stats.status} ${show(stats.text)}`
  );

  for (const each of ["/api/v1/certificates", path, "/api/v1/crls", targetPath, "/api/v1/stats"]) {
    const head = await read(base, each, "HEAD");
    check(head.ok && head.text === "", `HEAD ${each}: ${head.status}, no body`);
  }
}

const server = createTestHarness({
  root,
  workers: [
    {
      configPath: "./wrangler.jsonc",
      prebuiltWorkerDir: "./dist/worker",
      secrets: { AIA_ADMIN_TOKEN: ADMIN_TOKEN, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
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
  const targets = await downloadSegment(url);
  console.log("worker-smoke: publish");
  await publishSegment(url, targets);
  console.log("worker-smoke: reads");
  await readSegment(url, targets);
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
