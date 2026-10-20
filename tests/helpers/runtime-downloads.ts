// What both runtimes must send for the root CA's download (implementation slice 3, exit "GET / HEAD
// 两条运行时一致"): certs/root-ca.der under /ca/root-ca.crt and its PEM under the `.pem` path, as
// four headers and a body digest. Computed from the fixture files alone, never through src/core:
// tests/integration/downloads.test.ts (Node, @hono/node-server) and scripts/worker-smoke.ts
// (workerd, createTestHarness) both compare against these values, so passing both means the two
// runtimes agree. The PEM is OpenSSL's certs/root-ca.pem, which derToPem reproduces byte for byte
// (tests/core/pki/pem.test.ts). Imports only node:crypto and the fixture reader, since the Worker
// smoke loads it too. Slice 4 adds the root CA's published full CRL (rootCaCrlDownloads), which the
// Worker smoke checks after publishing it through POST /api/v1/crls.
import { createHash } from "node:crypto";
import { fixture, manifest } from "../fixtures/pki.ts";

/** The headers compared across runtimes, in the order they are printed. */
export const COMPARED_HEADERS = [
  "ETag",
  "Content-Length",
  "Content-Type",
  "Cache-Control",
] as const;

export type ComparedHeader = (typeof COMPARED_HEADERS)[number];

/** The DER download of the root CA; `${ROOT_CA_PATH}.pem` is its PEM. */
export const ROOT_CA_PATH = "/ca/root-ca.crt";

export interface RuntimeDownload {
  path: string;
  /** GET and HEAD send exactly these values. */
  headers: Record<ComparedHeader, string>;
  /** Lowercase hex SHA-256 of the GET body. */
  bodySha256: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Lowercase hex SHA-256 (synchronous, unlike src/core/digest.ts). */
export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rootCaEntry() {
  const entry = manifest.certificates.find((certificate) => certificate.name === "root-ca");
  if (entry === undefined) {
    throw new Error("tests/fixtures/pki/manifest.json has no certificate root-ca");
  }
  return entry;
}

/** certs/root-ca.der and its certificate id (the SHA-256 of the DER), for an import. */
export function rootCaCertificate(): { der: Uint8Array<ArrayBuffer>; id: string } {
  const der = fixture(rootCaEntry().der);
  return { der, id: sha256Of(der) };
}

/** ROOT_CA_PATH and its `.pem`, with the values both runtimes must send. */
export function rootCaDownloads(): RuntimeDownload[] {
  const { der, id } = rootCaCertificate();
  const pem = fixture(rootCaEntry().pem);
  return [
    {
      path: ROOT_CA_PATH,
      headers: {
        ETag: `"${id}"`,
        "Content-Length": String(der.byteLength),
        "Content-Type": "application/pkix-cert",
        "Cache-Control": IMMUTABLE,
      },
      bodySha256: id,
    },
    {
      path: `${ROOT_CA_PATH}.pem`,
      headers: {
        ETag: `"${id}-pem"`,
        "Content-Length": String(pem.byteLength),
        "Content-Type": "application/x-pem-file",
        "Cache-Control": IMMUTABLE,
      },
      bodySha256: sha256Of(pem),
    },
  ];
}

/** The compared headers of a response (missing ones as null), by name. */
export function comparedHeaders(
  get: (name: string) => string | null | undefined
): Record<ComparedHeader, string | null> {
  return Object.fromEntries(COMPARED_HEADERS.map((name) => [name, get(name) ?? null])) as Record<
    ComparedHeader,
    string | null
  >;
}

/** The root CA's full CRL path; `${ROOT_CA_CRL_PATH}.pem` is its PEM. */
export const ROOT_CA_CRL_PATH = "/crl/root-ca.crl";

/** The CRL the Worker smoke publishes to the root CA's full target. */
export const ROOT_CA_CRL = "crls/root-ca/full-01.der";

function crlEntry(file: string) {
  const entry = manifest.crls.find((crl) => crl.file === file);
  if (entry === undefined) {
    throw new Error(`tests/fixtures/pki/manifest.json has no CRL ${file}`);
  }
  return entry;
}

/**
 * The CRL Cache-Control at `now` (slice 3 step 3, written out again rather than imported): max-age
 * is the whole seconds until nextUpdate clamped to [60, 3600], 300 without nextUpdate. On a
 * runtime with the real clock ROOT_CA_CRL is long past its nextUpdate: max-age=60.
 */
export function crlCacheControl(nextUpdate: string | null, now: Date): string {
  const seconds =
    nextUpdate === null
      ? 300
      : Math.min(3600, Math.max(60, Math.floor((Date.parse(nextUpdate) - now.getTime()) / 1000)));
  return `public, max-age=${seconds}, must-revalidate`;
}

/** ROOT_CA_CRL under ROOT_CA_CRL_PATH and its `.pem` (OpenSSL's crls/root-ca/full-01.pem). */
export function rootCaCrlDownloads(now: Date): RuntimeDownload[] {
  const entry = crlEntry(ROOT_CA_CRL);
  const der = fixture(entry.file);
  const pem = fixture(entry.file.replace(/\.der$/, ".pem"));
  const cacheControl = crlCacheControl(entry.nextUpdate, now);
  return [
    {
      path: ROOT_CA_CRL_PATH,
      headers: {
        ETag: `"${entry.sha256}"`,
        "Content-Length": String(der.byteLength),
        "Content-Type": "application/pkix-crl",
        "Cache-Control": cacheControl,
      },
      bodySha256: sha256Of(der),
    },
    {
      path: `${ROOT_CA_CRL_PATH}.pem`,
      headers: {
        ETag: `"${entry.sha256}-pem"`,
        "Content-Length": String(pem.byteLength),
        "Content-Type": "application/x-pem-file",
        "Cache-Control": cacheControl,
      },
      bodySha256: sha256Of(pem),
    },
  ];
}
