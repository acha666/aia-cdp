import { describe, expect, it } from "vitest";
import { CatalogSchema, certificateBlobKey, ConfigSchema } from "../../src/core/catalog.ts";
import type { Catalog, Config } from "../../src/core/catalog.ts";
import { derToPem, PEM_BLOCK_MARKERS } from "../../src/core/pki/pem.ts";
import {
  downloadHeaders,
  downloadPaths,
  ifNoneMatchHit,
  resolveDownload,
} from "../../src/core/resources.ts";
import type { DownloadResolution, FoundDownload } from "../../src/core/resources.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { cert, certificateEntry, crlEntry, currentCrl } from "../helpers/catalog.ts";

// resolveDownload and the download header policy. What only the HTTP layer sees (Hono's decoding
// of %2F / %ZZ, the query string, dot segments) is tests/http/downloads.test.ts.

const HOUR = 3_600_000;
const ROOT = cert("root-ca");
const ISSUING = cert("issuing-ca-1");
const ISSUING_2 = cert("issuing-ca-2");
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";

// Not NOW, and with milliseconds, which an HTTP date drops.
const IMPORTED_AT = new Date(NOW.getTime() - 50 * HOUR - 250);
const PUBLISHED_AT = new Date(NOW.getTime() - 2 * HOUR - 750);

const NOT_FOUND = { status: "not_found" };

const ids = {
  full: crypto.randomUUID(),
  delta: crypto.randomUUID(),
  unpublished: crypto.randomUUID(),
  retired: crypto.randomUUID(),
};

const FULL_CURRENT = {
  ...(await currentCrl(FULL_01, ids.full)),
  publishedAt: PUBLISHED_AT.toISOString(),
};
const DELTA_CURRENT = await currentCrl(DELTA_01, ids.delta);
const ROOT_ENTRY = (await certificateEntry("root-ca", IMPORTED_AT)).entry;

// root-ca under three paths (one nested), issuing-ca-1 with a full CRL (full-01, nextUpdate 4 days
// after NOW) and a delta CRL (delta-01, expired), a target never published and a retired one.
const config: Config = ConfigSchema.parse({
  version: 1,
  certificates: { [ROOT.sha256]: { label: "Root CA" } },
  targets: {
    [ids.full]: { issuer: ISSUING.sha256, kind: "full", label: "Issuing CA 1" },
    [ids.delta]: { issuer: ISSUING.sha256, kind: "delta", label: "Issuing CA 1 delta" },
    [ids.unpublished]: { issuer: ROOT.sha256, kind: "full", label: "Root CA" },
    [ids.retired]: { issuer: ISSUING_2.sha256, kind: "full", label: "Issuing CA 2" },
  },
  paths: {
    "/ca/root-ca.crt": { certificate: ROOT.sha256 },
    "/ca/root.cer": { certificate: ROOT.sha256 },
    "/ca/sub/root-ca.crt": { certificate: ROOT.sha256 },
    "/crl/issuing-ca-1.crl": { target: ids.full },
    "/dcrl/issuing-ca-1.crl": { target: ids.delta },
    "/crl/root-ca.crl": { target: ids.unpublished },
    "/crl/issuing-ca-2.crl": { target: ids.retired },
  },
});

const catalog: Catalog = CatalogSchema.parse({
  version: 1,
  certificates: { [ROOT.sha256]: ROOT_ENTRY },
  targets: {
    [ids.full]: { current: FULL_CURRENT },
    [ids.delta]: { current: DELTA_CURRENT },
    [ids.retired]: { current: null },
  },
});

function found(resolution: DownloadResolution): FoundDownload {
  if (resolution.status !== "found") {
    throw new Error(`expected found, got ${JSON.stringify(resolution)}`);
  }
  return resolution;
}

const resolve = (path: string) => resolveDownload(config, catalog, path);

const headersOf = (path: string) => downloadHeaders(found(resolve(path)), NOW);

/** The length of the bytes a GET of `path` sends: the DER fixture, or derToPem of it. */
function bodyLength(path: string, file: string): string {
  const der = fixture(file);
  if (!path.endsWith(".pem")) {
    return String(der.byteLength);
  }
  const { begin, end } = path.startsWith("/ca/")
    ? PEM_BLOCK_MARKERS.certificate
    : PEM_BLOCK_MARKERS.crl;
  return String(new TextEncoder().encode(derToPem(der, begin, end)).byteLength);
}

describe("resolveDownload", () => {
  it("serves an exact path as DER and <path>.pem as PEM", () => {
    const der = {
      status: "found",
      kind: "certificate",
      format: "der",
      sha256: ROOT.sha256,
      key: certificateBlobKey(ROOT.sha256),
      size: fixture(ROOT.der).byteLength,
      filename: "root-ca.crt",
      nextUpdate: null,
      lastModified: IMPORTED_AT,
    };
    expect(resolve("/ca/root-ca.crt")).toEqual(der);
    expect(resolve("/ca/root-ca.crt.pem")).toEqual({
      ...der,
      format: "pem",
      filename: "root-ca.crt.pem",
    });
    // Every path of a certificate names the same blob; the filename is the last segment.
    expect(resolve("/ca/root.cer")).toEqual({ ...der, filename: "root.cer" });
    expect(resolve("/ca/sub/root-ca.crt")).toEqual(der);
  });

  // The other fields of a CRL download are checked through its headers below.
  it("serves a target's current CRL from its blob, with its kind and nextUpdate", () => {
    expect(resolve("/crl/issuing-ca-1.crl")).toMatchObject({
      kind: "full",
      format: "der",
      key: FULL_CURRENT.key,
      nextUpdate: new Date(crlEntry(FULL_01).nextUpdate ?? ""),
    });
    expect(resolve("/dcrl/issuing-ca-1.crl.pem")).toMatchObject({
      kind: "delta",
      format: "pem",
      key: DELTA_CURRENT.key,
    });
  });

  it("matches nothing but the path table and its .pem variants", () => {
    const misses = [
      "/ca/unknown.crt",
      "/ca/Root-CA.crt",
      "/ca/root-ca.crt.PEM",
      "/ca/root-ca.crt.pem.pem",
      "/ca/root-ca.pem",
      "/ca/root-ca.crt/",
      // c.req.path keeps %2F as it is; decoding would find /ca/sub/root-ca.crt.
      "/ca/sub%2Froot-ca.crt",
      // The request path is never a store key.
      `/${certificateBlobKey(ROOT.sha256)}`,
      `/${FULL_CURRENT.key}`,
      "/config.json",
      "/catalog.json",
      // Nor a property of Object.prototype.
      "/ca/__proto__",
      "constructor",
      "toString.pem",
    ];
    for (const path of misses) {
      expect(resolve(path), path).toEqual(NOT_FOUND);
    }
  });

  it("finds no unpublished or retired target, and nothing without config.json", () => {
    for (const path of ["/crl/root-ca.crl", "/crl/issuing-ca-2.crl.pem"]) {
      expect(resolve(path), path).toEqual(NOT_FOUND);
    }
    expect(resolveDownload(null, catalog, "/ca/root-ca.crt")).toEqual(NOT_FOUND);
  });

  it("reports a path entry the catalog or config.targets cannot back as inconsistent", () => {
    const { [ROOT.sha256]: _root, ...certificates } = catalog.certificates;
    expect(resolveDownload(config, { ...catalog, certificates }, "/ca/root-ca.crt.pem")).toEqual({
      status: "inconsistent",
      reference: { certificate: ROOT.sha256 },
    });
    // The catalog still holds a current CRL for it; the configuration no longer defines it.
    const { [ids.full]: _full, ...targets } = config.targets;
    expect(resolveDownload({ ...config, targets }, catalog, "/crl/issuing-ca-1.crl")).toEqual({
      status: "inconsistent",
      reference: { target: ids.full },
    });
  });
});

describe("downloadHeaders", () => {
  it("serves a certificate as immutable DER and PEM", () => {
    const common = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Last-Modified": IMPORTED_AT.toUTCString(),
    };
    expect(headersOf("/ca/root-ca.crt")).toEqual({
      ...common,
      "Content-Type": "application/pkix-cert",
      ETag: `"${ROOT.sha256}"`,
      "Content-Length": bodyLength("/ca/root-ca.crt", ROOT.der),
      "Content-Disposition": 'attachment; filename="root-ca.crt"',
    });
    expect(headersOf("/ca/root-ca.crt.pem")).toEqual({
      ...common,
      "Content-Type": "application/x-pem-file",
      ETag: `"${ROOT.sha256}-pem"`,
      "Content-Length": bodyLength("/ca/root-ca.crt.pem", ROOT.der),
      "Content-Disposition": 'attachment; filename="root-ca.crt.pem"',
    });
  });

  it("serves a CRL with a clamped max-age and must-revalidate", () => {
    expect(headersOf("/crl/issuing-ca-1.crl")).toEqual({
      "Content-Type": "application/pkix-crl",
      ETag: `"${crlEntry(FULL_01).sha256}"`,
      "Content-Length": bodyLength("/crl/issuing-ca-1.crl", FULL_01),
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Last-Modified": PUBLISHED_AT.toUTCString(),
      "Content-Disposition": 'attachment; filename="issuing-ca-1.crl"',
    });
    expect(headersOf("/dcrl/issuing-ca-1.crl.pem")).toEqual({
      "Content-Type": "application/x-pem-file",
      ETag: `"${crlEntry(DELTA_01).sha256}-pem"`,
      "Content-Length": bodyLength("/dcrl/issuing-ca-1.crl.pem", DELTA_01),
      "Cache-Control": "public, max-age=60, must-revalidate",
      "Last-Modified": NOW.toUTCString(),
      "Content-Disposition": 'attachment; filename="issuing-ca-1.crl.pem"',
    });
  });

  it("counts a CRL's max-age in whole seconds until nextUpdate, within [60, 3600], 300 without", () => {
    const download = found(resolve("/crl/issuing-ca-1.crl"));
    const maxAge = (seconds: number) => `public, max-age=${seconds}, must-revalidate`;
    const nextUpdate = download.nextUpdate?.getTime() ?? Number.NaN;
    const cases: [msBefore: number, seconds: number][] = [
      [-HOUR, 60],
      [0, 60],
      [60_999, 60],
      [61_000, 61],
      [1_234_900, 1234],
      [3_600_000, 3600],
      [3_601_000, 3600],
    ];
    for (const [ms, seconds] of cases) {
      const now = new Date(nextUpdate - ms);
      expect(downloadHeaders(download, now)["Cache-Control"], `${ms} ms`).toBe(maxAge(seconds));
    }
    expect(downloadHeaders({ ...download, nextUpdate: null }, NOW)["Cache-Control"]).toBe(
      maxAge(300)
    );
  });
});

it("ifNoneMatchHit matches the ETag, weakly, in a list or as *, and nothing else", () => {
  const etag = `"${ROOT.sha256}"`;
  const hits = [etag, `W/${etag}`, ` "${ISSUING.sha256}" ,W/${etag} , "x"`, "*", "  * "];
  for (const header of hits) {
    expect(ifNoneMatchHit(header, etag), header).toBe(true);
  }
  const misses = [
    `"${ISSUING.sha256}"`,
    // The other representation of the same certificate.
    `"${ROOT.sha256}-pem"`,
    // W/ is case-sensitive; * only stands alone.
    `w/${etag}`,
    `"${ISSUING.sha256}", *`,
    "",
    undefined,
    null,
  ];
  for (const header of misses) {
    expect(ifNoneMatchHit(header, etag), String(header)).toBe(false);
  }
});

it("downloadPaths lists a reference's paths in code-unit order, each followed by its .pem", () => {
  expect(downloadPaths(config, { certificate: ROOT.sha256 })).toEqual([
    "/ca/root-ca.crt",
    "/ca/root-ca.crt.pem",
    "/ca/root.cer",
    "/ca/root.cer.pem",
    "/ca/sub/root-ca.crt",
    "/ca/sub/root-ca.crt.pem",
  ]);
  expect(downloadPaths(config, { target: ids.delta })).toEqual([
    "/dcrl/issuing-ca-1.crl",
    "/dcrl/issuing-ca-1.crl.pem",
  ]);
  expect(downloadPaths(config, { certificate: ISSUING_2.sha256 })).toEqual([]);
  expect(downloadPaths(null, { target: ids.full })).toEqual([]);
});
