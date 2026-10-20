import { describe, expect, it } from "vitest";
import { checkConfigState, checkConfigStatic } from "../../src/core/admin.ts";
import { CatalogSchema, certificateBlobKey, ConfigSchema } from "../../src/core/catalog.ts";
import type { Catalog, Config, ConfigTarget, CrlKind } from "../../src/core/catalog.ts";
import { derToPem, PEM_BLOCK_MARKERS } from "../../src/core/pki/pem.ts";
import { downloadHeaders, ifNoneMatchHit, resolveDownload } from "../../src/core/resources.ts";
import type { DownloadResolution, FoundDownload } from "../../src/core/resources.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import { cert, certificateEntry, currentCrl } from "../helpers/catalog.ts";

// resolveDownload (slice 3 step 2, M20) and the download header policy (step 3). The Cache-Control
// cases migrate worker-aia-cdp@5b570aa:tests/worker/cache-config.test.ts:78-114 with the new
// expectations: no s-maxage / stale-while-revalidate (C7), an expired CRL 60 instead of 0 and a far
// nextUpdate 3600 instead of unbounded (§10 #3). What only the HTTP layer sees (Hono's decoding of
// %2F / %ZZ, the query string, dot segments) is tests/http/downloads.test.ts.

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

function crlEntry(file: string) {
  const found = manifest.crls.find((entry) => entry.file === file);
  if (!found) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

const ids = {
  full: crypto.randomUUID(),
  delta: crypto.randomUUID(),
  unpublished: crypto.randomUUID(),
  retired: crypto.randomUUID(),
};

const certificates = Object.fromEntries(
  await Promise.all(
    [ROOT, ISSUING, ISSUING_2].map(async ({ name }) => {
      const { id, entry } = await certificateEntry(name, IMPORTED_AT);
      return [id, entry] as const;
    })
  )
);

const FULL_CURRENT = {
  ...(await currentCrl(FULL_01, ids.full)),
  publishedAt: PUBLISHED_AT.toISOString(),
};
const DELTA_CURRENT = await currentCrl(DELTA_01, ids.delta);

/**
 * root-ca under four paths (one nested, one without a suffix), issuing-ca-1 with a full (full-01,
 * nextUpdate 4 days after NOW; also under a .der path) and a delta CRL (delta-01, expired), a
 * target that was never published and a retired one.
 */
const config: Config = ConfigSchema.parse({
  version: 1,
  certificates: {
    [ROOT.sha256]: { label: "Root CA" },
    [ISSUING.sha256]: { label: "Issuing CA 1" },
    [ISSUING_2.sha256]: { label: "Issuing CA 2" },
  },
  targets: {
    [ids.full]: { issuer: ISSUING.sha256, kind: "full", label: "Issuing CA 1" },
    [ids.delta]: { issuer: ISSUING.sha256, kind: "delta", label: "Issuing CA 1 delta" },
    [ids.unpublished]: { issuer: ROOT.sha256, kind: "full", label: "Root CA" },
    [ids.retired]: { issuer: ISSUING_2.sha256, kind: "full", label: "Issuing CA 2" },
  },
  paths: {
    "/ca/root-ca.crt": { certificate: ROOT.sha256 },
    "/ca/root.cer": { certificate: ROOT.sha256 },
    "/ca/root": { certificate: ROOT.sha256 },
    "/ca/sub/root-ca.crt": { certificate: ROOT.sha256 },
    "/ca/issuing-ca-1.crt": { certificate: ISSUING.sha256 },
    "/crl/issuing-ca-1.crl": { target: ids.full },
    "/crl/issuing-ca-1.der": { target: ids.full },
    "/dcrl/issuing-ca-1.crl": { target: ids.delta },
    "/crl/root-ca.crl": { target: ids.unpublished },
    "/crl/issuing-ca-2.crl": { target: ids.retired },
  },
});

const catalog: Catalog = CatalogSchema.parse({
  version: 1,
  certificates,
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

const headersOf = (path: string, now = NOW) => downloadHeaders(found(resolve(path)), now);

/** The bytes a GET of `path` sends: the DER fixture, or derToPem of it. */
function body(path: string, der: Uint8Array): Uint8Array {
  if (!path.endsWith(".pem")) {
    return der;
  }
  const { begin, end } = path.startsWith("/ca/")
    ? PEM_BLOCK_MARKERS.certificate
    : PEM_BLOCK_MARKERS.crl;
  return new TextEncoder().encode(derToPem(der, begin, end));
}

/** The found download of a one-target state whose current CRL is the fixture `file`. */
async function crlDownload(file: string, kind: CrlKind): Promise<FoundDownload> {
  const id = crypto.randomUUID();
  const path = kind === "full" ? "/crl/x.crl" : "/dcrl/x.crl";
  const single = ConfigSchema.parse({
    version: 1,
    certificates: { [ISSUING.sha256]: { label: "Issuing CA 1" } },
    targets: { [id]: { issuer: ISSUING.sha256, kind, label: kind } },
    paths: { [path]: { target: id } },
  });
  const state = CatalogSchema.parse({
    version: 1,
    certificates,
    targets: { [id]: { current: await currentCrl(file, id) } },
  });
  return found(resolveDownload(single, state, path));
}

describe("resolveDownload", () => {
  it("runs on a state that passes the static and state rules", () => {
    expect(checkConfigStatic(config).ok).toBe(true);
    expect(checkConfigState(config, catalog)).toEqual([]);
  });

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
  });

  it("serves a target's current CRL with its kind and nextUpdate", () => {
    const full = crlEntry(FULL_01);
    expect(resolve("/crl/issuing-ca-1.crl")).toEqual({
      status: "found",
      kind: "full",
      format: "der",
      sha256: full.sha256,
      key: FULL_CURRENT.key,
      size: fixture(FULL_01).byteLength,
      filename: "issuing-ca-1.crl",
      nextUpdate: new Date(full.nextUpdate ?? ""),
      lastModified: PUBLISHED_AT,
    });
    const delta = crlEntry(DELTA_01);
    expect(resolve("/dcrl/issuing-ca-1.crl.pem")).toEqual({
      status: "found",
      kind: "delta",
      format: "pem",
      sha256: delta.sha256,
      key: DELTA_CURRENT.key,
      size: fixture(DELTA_01).byteLength,
      filename: "issuing-ca-1.crl.pem",
      nextUpdate: new Date(delta.nextUpdate ?? ""),
      lastModified: NOW,
    });
  });

  it("resolves several paths of one certificate to the same digest and blob", () => {
    const [a, b, nested] = ["/ca/root-ca.crt", "/ca/root.cer", "/ca/sub/root-ca.crt"].map((path) =>
      found(resolve(path))
    );
    expect(b).toEqual({ ...a, filename: "root.cer" });
    // The filename is the last segment.
    expect(nested).toEqual(a);
  });

  it("matches nothing but the path table and its .pem variants", () => {
    const misses = [
      "/ca/unknown.crt",
      "/ca/Root-CA.crt",
      "/CA/root-ca.crt",
      "/ca/root-ca.crt.PEM",
      "/ca/root-ca.crt.pem.pem",
      "/ca/root-ca.pem",
      "/ca/root-ca",
      "/ca/root-ca.crt/",
      "/ca//root-ca.crt",
      "/ca/",
      "/ca",
      "/ca/root-ca.crt/.pem",
      // c.req.path keeps %2F and malformed escapes as they are; decoding would find
      // /ca/sub/root-ca.crt.
      "/ca/a%2Fb.crt",
      "/ca/sub%2Froot-ca.crt",
      "/ca/sub%2froot-ca.crt",
      "/ca/sub%2Froot-ca.crt.pem",
      "/ca/%ZZ.crt",
      // Store keys and internal objects: the request path is never a key.
      certificateBlobKey(ROOT.sha256),
      `/${certificateBlobKey(ROOT.sha256)}`,
      `/ca/${certificateBlobKey(ROOT.sha256)}`,
      `/${FULL_CURRENT.key}`,
      `/crl/${FULL_CURRENT.key}`,
      "/crl/archive/x.crl",
      "/config.json",
      "/catalog.json",
    ];
    for (const path of misses) {
      expect(resolve(path), path).toEqual(NOT_FOUND);
    }
  });

  it("does not find a target that was never published or is retired", () => {
    for (const path of ["/crl/root-ca.crl", "/crl/issuing-ca-2.crl"]) {
      expect(resolve(path), path).toEqual(NOT_FOUND);
      expect(resolve(`${path}.pem`), path).toEqual(NOT_FOUND);
    }
  });

  it("finds nothing without config.json", () => {
    expect(resolveDownload(null, catalog, "/ca/root-ca.crt")).toEqual(NOT_FOUND);
    expect(resolveDownload(null, catalog, "/ca/root-ca.crt.pem")).toEqual(NOT_FOUND);
  });

  it("never reaches Object.prototype through a path", () => {
    const paths = [
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "constructor.pem",
      "toString.pem",
      "/ca/__proto__",
      "/ca/__proto__.pem",
      "/ca/constructor",
      "/ca/constructor.pem",
    ];
    for (const path of paths) {
      expect(resolve(path), path).toEqual(NOT_FOUND);
    }
  });

  // The schemas reject such ids (V1); resolveDownload does not rely on that.
  it("never reaches Object.prototype through an id", () => {
    const valueOf: ConfigTarget = { issuer: ISSUING.sha256, kind: "full", label: "valueOf" };
    const hostile: Config = {
      ...config,
      targets: { ...config.targets, valueOf },
      paths: {
        "/ca/proto.crt": { certificate: "__proto__" },
        "/ca/constructor.crt": { certificate: "constructor" },
        "/crl/proto.crl": { target: "__proto__" },
        "/crl/constructor.crl": { target: "constructor" },
        "/crl/value-of.crl": { target: "valueOf" },
      },
    };
    const resolveHostile = (path: string) => resolveDownload(hostile, catalog, path);
    for (const id of ["__proto__", "constructor"]) {
      const name = id === "__proto__" ? "proto" : id;
      for (const suffix of ["", ".pem"]) {
        expect(resolveHostile(`/ca/${name}.crt${suffix}`)).toEqual({
          status: "inconsistent",
          reference: { certificate: id },
        });
        expect(resolveHostile(`/crl/${name}.crl${suffix}`)).toEqual({
          status: "inconsistent",
          reference: { target: id },
        });
      }
    }
    // Defined in config.targets, absent from catalog.targets: not published.
    expect(resolveHostile("/crl/value-of.crl")).toEqual(NOT_FOUND);
  });

  it("reports a certificate missing from the catalog as inconsistent", () => {
    const stale = CatalogSchema.parse({
      ...catalog,
      certificates: without(catalog.certificates, ROOT.sha256),
    });
    for (const path of ["/ca/root-ca.crt", "/ca/root-ca.crt.pem", "/ca/root.cer"]) {
      expect(resolveDownload(config, stale, path), path).toEqual({
        status: "inconsistent",
        reference: { certificate: ROOT.sha256 },
      });
    }
    expect(resolveDownload(config, stale, "/ca/issuing-ca-1.crt").status).toBe("found");
  });

  it("reports a target missing from config.targets as inconsistent", () => {
    // The catalog still holds a current CRL for it; the configuration no longer defines it.
    const stale = ConfigSchema.parse({ ...config, targets: without(config.targets, ids.full) });
    for (const path of ["/crl/issuing-ca-1.crl", "/crl/issuing-ca-1.crl.pem"]) {
      expect(resolveDownload(stale, catalog, path), path).toEqual({
        status: "inconsistent",
        reference: { target: ids.full },
      });
    }
    expect(resolveDownload(stale, catalog, "/dcrl/issuing-ca-1.crl").status).toBe("found");
  });
});

describe("downloadHeaders", () => {
  it("serves a certificate as immutable DER and PEM", () => {
    const der = fixture(ROOT.der);
    const common = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Last-Modified": IMPORTED_AT.toUTCString(),
    };
    expect(headersOf("/ca/root-ca.crt")).toEqual({
      ...common,
      "Content-Type": "application/pkix-cert",
      ETag: `"${ROOT.sha256}"`,
      "Content-Length": String(der.byteLength),
      "Content-Disposition": 'attachment; filename="root-ca.crt"',
    });
    expect(headersOf("/ca/root-ca.crt.pem")).toEqual({
      ...common,
      "Content-Type": "application/x-pem-file",
      ETag: `"${ROOT.sha256}-pem"`,
      "Content-Length": String(body("/ca/root-ca.crt.pem", der).byteLength),
      "Content-Disposition": 'attachment; filename="root-ca.crt.pem"',
    });
    // Immutable whatever the clock says.
    const later = new Date(NOW.getTime() + 1000 * 24 * HOUR);
    expect(headersOf("/ca/root-ca.crt", later)["Cache-Control"]).toBe(common["Cache-Control"]);
  });

  it("serves a CRL with a clamped max-age and must-revalidate", () => {
    const full = fixture(FULL_01);
    expect(headersOf("/crl/issuing-ca-1.crl")).toEqual({
      "Content-Type": "application/pkix-crl",
      ETag: `"${crlEntry(FULL_01).sha256}"`,
      "Content-Length": String(full.byteLength),
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Last-Modified": PUBLISHED_AT.toUTCString(),
      "Content-Disposition": 'attachment; filename="issuing-ca-1.crl"',
    });
    const delta = fixture(DELTA_01);
    expect(headersOf("/dcrl/issuing-ca-1.crl.pem")).toEqual({
      "Content-Type": "application/x-pem-file",
      ETag: `"${crlEntry(DELTA_01).sha256}-pem"`,
      "Content-Length": String(body("/dcrl/issuing-ca-1.crl.pem", delta).byteLength),
      "Cache-Control": "public, max-age=60, must-revalidate",
      "Last-Modified": NOW.toUTCString(),
      "Content-Disposition": 'attachment; filename="issuing-ca-1.crl.pem"',
    });
  });

  it("picks the Content-Type by kind and format", () => {
    const types = {
      "/ca/root-ca.crt": "application/pkix-cert",
      "/ca/root.cer": "application/pkix-cert",
      "/ca/root-ca.crt.pem": "application/x-pem-file",
      // C6: by kind, not by the path's suffix (the old code: octet-stream, and a .der CRL a cert).
      "/ca/root": "application/pkix-cert",
      "/ca/root.pem": "application/x-pem-file",
      "/crl/issuing-ca-1.der": "application/pkix-crl",
      "/crl/issuing-ca-1.der.pem": "application/x-pem-file",
      "/crl/issuing-ca-1.crl": "application/pkix-crl",
      "/crl/issuing-ca-1.crl.pem": "application/x-pem-file",
      "/dcrl/issuing-ca-1.crl": "application/pkix-crl",
      "/dcrl/issuing-ca-1.crl.pem": "application/x-pem-file",
    };
    for (const [path, type] of Object.entries(types)) {
      expect(headersOf(path)["Content-Type"], path).toBe(type);
    }
  });

  it("states the length of the bytes a GET sends, without reading them", () => {
    const sources = {
      "/ca/root-ca.crt": ROOT.der,
      "/ca/issuing-ca-1.crt.pem": ISSUING.der,
      "/crl/issuing-ca-1.crl": FULL_01,
      "/crl/issuing-ca-1.crl.pem": FULL_01,
      "/dcrl/issuing-ca-1.crl": DELTA_01,
      "/dcrl/issuing-ca-1.crl.pem": DELTA_01,
    };
    for (const [path, file] of Object.entries(sources)) {
      expect(headersOf(path)["Content-Length"], path).toBe(
        String(body(path, fixture(file)).byteLength)
      );
    }
  });

  it("writes Last-Modified as an HTTP date in whole seconds", () => {
    const value = headersOf("/ca/root-ca.crt")["Last-Modified"];
    expect(value).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(Date.parse(value)).toBe(Math.floor(IMPORTED_AT.getTime() / 1000) * 1000);
  });

  describe("CRL max-age", () => {
    const cacheControl = (download: FoundDownload, now: Date) =>
      downloadHeaders(download, now)["Cache-Control"];
    const maxAge = (seconds: number) => `public, max-age=${seconds}, must-revalidate`;

    it("is 300 without nextUpdate", async () => {
      const download = await crlDownload("crls/issuing-ca-1/full-no-next-update.der", "full");
      expect(download.nextUpdate).toBeNull();
      expect(cacheControl(download, NOW)).toBe(maxAge(300));
    });

    it("is 60 once nextUpdate has passed (was 0)", async () => {
      const download = await crlDownload(DELTA_01, "delta");
      expect(download.nextUpdate?.getTime()).toBeLessThan(NOW.getTime());
      expect(cacheControl(download, NOW)).toBe(maxAge(60));
    });

    it("is at most 3600 for a far nextUpdate (was unbounded)", async () => {
      const download = await crlDownload("crls/issuing-ca-1/full-future.der", "full");
      expect(cacheControl(download, NOW)).toBe(maxAge(3600));
    });

    it("counts whole seconds until nextUpdate between the bounds", async () => {
      const download = await crlDownload(FULL_01, "full");
      const nextUpdate = download.nextUpdate?.getTime() ?? Number.NaN;
      const before = (ms: number) => new Date(nextUpdate - ms);
      const cases: [ms: number, seconds: number][] = [
        [1_234_900, 1234],
        [0, 60],
        [60_999, 60],
        [61_000, 61],
        [3_599_999, 3599],
        [3_600_000, 3600],
        [3_601_000, 3600],
      ];
      for (const [ms, seconds] of cases) {
        expect(cacheControl(download, before(ms)), `${ms} ms`).toBe(maxAge(seconds));
      }
    });
  });

  it('sanitises the filename: ", \\, control characters and non-ASCII become _', () => {
    const segment = 'a"b\\c\u0001d\te\u007fé€\u{1f600} f.crt';
    const odd: Config = { ...config, paths: { [`/ca/${segment}`]: { certificate: ROOT.sha256 } } };
    const disposition = (path: string) =>
      downloadHeaders(found(resolveDownload(odd, catalog, path)), NOW)["Content-Disposition"];
    expect(disposition(`/ca/${segment}`)).toBe('attachment; filename="a_b_c_d_e____ f.crt"');
    expect(disposition(`/ca/${segment}.pem`)).toBe(
      'attachment; filename="a_b_c_d_e____ f.crt.pem"'
    );
  });
});

describe("ifNoneMatchHit", () => {
  const etag = `"${ROOT.sha256}"`;

  it("matches the ETag, weakly, in a list or as *", () => {
    const hits = [
      etag,
      `W/${etag}`,
      ` "${ISSUING.sha256}" ,W/${etag} , "${ISSUING_2.sha256}"`,
      `"${ISSUING.sha256}",${etag}`,
      "*",
      "  * ",
    ];
    for (const header of hits) {
      expect(ifNoneMatchHit(header, etag), header).toBe(true);
    }
    const pem = `"${ROOT.sha256}-pem"`;
    expect(ifNoneMatchHit(`W/${pem}`, pem)).toBe(true);
  });

  it("does not match other, unquoted, empty or missing values", () => {
    const misses = [
      `"${ISSUING.sha256}"`,
      `"${ISSUING.sha256}", "${ISSUING_2.sha256}"`,
      // The other representation of the same certificate.
      `"${ROOT.sha256}-pem"`,
      // The old service's unquoted ETags.
      ROOT.sha256,
      `W/${ROOT.sha256}`,
      // W/ is case-sensitive; * only stands alone.
      `w/${etag}`,
      `"${ISSUING.sha256}", *`,
      "",
      " ",
    ];
    for (const header of misses) {
      expect(ifNoneMatchHit(header, etag), header).toBe(false);
    }
    expect(ifNoneMatchHit(undefined, etag)).toBe(false);
    expect(ifNoneMatchHit(null, etag)).toBe(false);
  });
});
