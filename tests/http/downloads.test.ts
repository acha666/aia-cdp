// Download routes: DER as stored and PEM derived on read, the headers, If-None-Match, HEAD, the
// text/plain 404 / 405 and the 500 of a store that fails or lost a blob, through
// createApp().request() on a seeded MemoryStore.
import { describe, expect, it } from "vitest";
import { certificateBlobKey } from "../../src/core/catalog.ts";
import { derToPem } from "../../src/core/pki/pem.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, crlEntry, fixture } from "../fixtures/pki.ts";
import { logRecords, patchStore, testDeps } from "../helpers/app.ts";
import { expectInternal } from "../helpers/reads.ts";
import { DOWNLOAD_PATHS, SEED_CRLS, seedDownloads } from "../helpers/seed-downloads.ts";
import type { DownloadSeedOptions } from "../helpers/seed-downloads.ts";
import { opaqueEtagStore } from "../helpers/store.ts";

const P = DOWNLOAD_PATHS;
const ROOT = cert("root-ca");
const ISSUING = cert("issuing-ca-1");
const FULL = crlEntry(SEED_CRLS.full);
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Every blob read fails: what still answers never read the blob. */
const BLOBS = (key: string) => key.startsWith("blobs/");

interface SetupOptions extends DownloadSeedOptions {
  /** `get` of these keys throws. */
  failGet?: (key: string) => boolean;
}

/**
 * createApp on a MemoryStore holding the seed, behind store ETags that are not the digest (a
 * download ETag comes from the catalog). The ui answers index.html for every path, so a download
 * miss that reached it would be a 200.
 */
async function setup(options: SetupOptions = {}) {
  const { failGet, ...seedOptions } = options;
  const base = new MemoryStore();
  const seed = await seedDownloads(base, seedOptions);
  const opaque = opaqueEtagStore(base);
  const store = patchStore(
    {
      get: async (key) => {
        if (failGet?.(key)) {
          throw new Error(`private storage details of ${key}`);
        }
        return opaque.get(key);
      },
    },
    opaque
  );
  const deps = testDeps({
    store,
    ui: () =>
      new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  });
  const app = createApp(deps);
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://localhost${path}`, init);
  return { deps, seed, base, request };
}

const DOWNLOAD_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
];

/** The download headers of a response, by lowercase name (the secure headers left out). */
function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries(
    DOWNLOAD_HEADERS.flatMap((name) => {
      const value = res.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

function httpDate(iso: string | undefined): string {
  if (iso === undefined) {
    throw new Error("no timestamp");
  }
  return new Date(iso).toUTCString();
}

describe("bytes", () => {
  it.each([
    [P.root, fixture(ROOT.der)],
    [`${P.root}.pem`, fixture(ROOT.pem)],
    // Every path of a certificate names the same blob.
    [P.rootAlias, fixture(ROOT.der)],
    [P.nested, fixture(ROOT.der)],
    [P.full, fixture(SEED_CRLS.full)],
    // OpenSSL's PEM of the fixture: the same text as the one derived on read.
    [`${P.full}.pem`, fixture(SEED_CRLS.full.replace(/\.der$/, ".pem"))],
    [`${P.delta}.pem`, new TextEncoder().encode(derToPem(fixture(SEED_CRLS.delta), "crl"))],
  ])("GET %s sends the stored DER or the PEM derived from it", async (path, body) => {
    const { request } = await setup();
    const res = await request(path);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(body);
    expect(res.headers.get("Content-Length")).toBe(String(body.byteLength));
    // The file name is the last segment of the path.
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${path.split("/").at(-1) ?? ""}"`
    );
  });
});

describe("headers", () => {
  it("certificate DER, GET: immutable, the digest as ETag, the path's file name", async () => {
    const { request, seed } = await setup();
    const res = await request(P.root);
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt"',
      "content-length": String(fixture(ROOT.der).byteLength),
      "content-type": "application/pkix-cert",
      etag: `"${ROOT.sha256}"`,
      "last-modified": httpDate(seed.catalog.certificates[ROOT.sha256]?.importedAt),
    });
  });

  it("certificate PEM, HEAD: every header, no body, the blob not read", async () => {
    const { request, seed } = await setup({ failGet: BLOBS });
    const res = await request(`${P.root}.pem`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt.pem"',
      "content-length": String(fixture(ROOT.pem).byteLength),
      "content-type": "application/x-pem-file",
      etag: `"${ROOT.sha256}-pem"`,
      "last-modified": httpDate(seed.catalog.certificates[ROOT.sha256]?.importedAt),
    });
    expect(await res.text()).toBe("");
  });

  it("CRL DER, GET (nextUpdate 4 days after NOW → max-age 3600)", async () => {
    const { request, seed } = await setup();
    const res = await request(P.full);
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": "public, max-age=3600, must-revalidate",
      "content-disposition": 'attachment; filename="issuing-ca-1.crl"',
      "content-length": String(fixture(SEED_CRLS.full).byteLength),
      "content-type": "application/pkix-crl",
      etag: `"${FULL.sha256}"`,
      "last-modified": httpDate(seed.catalog.targets[seed.targets.full]?.current?.publishedAt),
    });
  });

  it.each<{ title: string; path: string; options: DownloadSeedOptions; maxAge: number }>([
    { title: "full-01: nextUpdate 4 days after NOW", path: P.full, options: {}, maxAge: 3600 },
    { title: "delta-01: expired at NOW", path: P.delta, options: {}, maxAge: 60 },
    {
      title: "a CRL without nextUpdate",
      path: P.full,
      options: { full: SEED_CRLS.fullWithoutNextUpdate },
      maxAge: 300,
    },
  ])("CRL Cache-Control, $title → max-age $maxAge", async ({ path, options, maxAge }) => {
    const { request } = await setup(options);
    for (const variant of [path, `${path}.pem`]) {
      const res = await request(variant);
      expect(res.status, variant).toBe(200);
      expect(res.headers.get("Cache-Control"), variant).toBe(
        `public, max-age=${maxAge}, must-revalidate`
      );
    }
  });
});

describe("If-None-Match", () => {
  const der = `"${ROOT.sha256}"`;
  const pem = `"${ROOT.sha256}-pem"`;

  it.each([
    ["the exact ETag", P.root, der],
    ["a weak ETag", P.root, `W/${der}`],
    ["a list with a weak member", P.root, ` "other" , W/${der} `],
    ["*", P.root, "*"],
    ["* with spaces", P.root, "  * "],
    ["the PEM ETag on the PEM path", `${P.root}.pem`, pem],
    ["the CRL's ETag", P.full, `"${FULL.sha256}"`],
  ])("%s → 304 with ETag and Cache-Control only, the blob not read", async (_, path, header) => {
    const { request } = await setup({ failGet: BLOBS });
    for (const method of ["GET", "HEAD"]) {
      const res = await request(path, { method, headers: { "If-None-Match": header } });
      expect(res.status, method).toBe(304);
      expect(await res.text(), method).toBe("");
      expect(Object.keys(headersOf(res)), method).toEqual(["cache-control", "etag"]);
    }
  });

  it.each([
    ["another ETag", P.root, `"${ISSUING.sha256}"`],
    ["the PEM ETag on the DER path", P.root, pem],
    ["the DER ETag on the PEM path", `${P.root}.pem`, der],
    // W/ is case-sensitive; * only stands alone.
    ["a lowercase w/", P.root, `w/${der}`],
    ["* in a list", P.root, '"x", *'],
    ["an empty header", P.root, ""],
  ])("%s → 200 with the body", async (_, path, header) => {
    const { request } = await setup();
    const res = await request(path, { headers: { "If-None-Match": header } });
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).byteLength).toBe(Number(res.headers.get("Content-Length")));
  });
});

describe("text/plain 404 and 405", () => {
  it.each([
    ["an unknown path", "/ca/unknown.crt"],
    ["a second .pem", `${P.root}.pem.pem`],
    ["another case", "/ca/Root-CA.crt"],
    ["an uppercase .PEM", `${P.root}.PEM`],
    [".pem in place of the extension", "/ca/root-ca.pem"],
    // A property of Object.prototype is no path.
    ["__proto__", "/ca/__proto__"],
    // P.nested is served: decoding %2F would find it.
    ["an encoded slash in a served nested path", "/ca/sub%2Froot-ca.crt"],
    ["an encoded parent segment", "/ca/..%2Fconfig.json"],
    ["a double slash", "/ca//root-ca.crt"],
    ["a trailing slash", `${P.root}/`],
    ["the prefix with a slash", "/ca/"],
    ["/crl alone", "/crl"],
    ["a target that was never published", P.unpublished],
    ["a retired target (current null)", `${P.retired}.pem`],
  ])("%s: %s, never the ui, never 304", async (_, path) => {
    const { request } = await setup({ failGet: BLOBS });
    for (const method of ["GET", "HEAD"]) {
      // If-None-Match: * only matches a current representation (RFC 9110 §13.1.2).
      for (const headers of [{}, { "If-None-Match": "*" }]) {
        const res = await request(path, { method, headers });
        expect(res.status, method).toBe(404);
        expect(res.headers.get("Content-Type"), method).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), method).toBe("no-store");
        expect(await res.text(), method).toBe(method === "GET" ? "Not Found" : "");
      }
    }
  });

  it.each(["POST", "PUT", "DELETE"])(
    "%s on a download path → 405 Allow: GET, HEAD, before any read",
    async (method) => {
      const { request } = await setup({ failGet: () => true });
      for (const path of [P.root, `${P.root}.pem`, P.full, "/crl/missing.crl", "/ca"]) {
        const res = await request(path, { method });
        expect(res.status, path).toBe(405);
        expect(res.headers.get("Allow"), path).toBe("GET, HEAD");
        expect(res.headers.get("Content-Type"), path).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), path).toBe("no-store");
        expect(await res.text(), path).toBe("Method Not Allowed");
      }
    }
  );
});

describe("500", () => {
  it("store get throws → 500 internal; the error text only reaches the log", async () => {
    const { request, deps } = await setup({ failGet: () => true });
    await expectInternal(await request(P.root), "private", "blobs/");
    const message = expect.stringContaining("private storage details") as unknown;
    expect(logRecords(deps).filter((line) => line.msg === "unhandled_error")).toMatchObject([
      { path: P.root, error: { message } },
    ]);
  });

  it("blob missing → 500 for GET; HEAD still answers from the catalog", async () => {
    const { base, request } = await setup();
    await base.delete(certificateBlobKey(ROOT.sha256));
    await expectInternal(await request(P.root), "blobs/");
    expect((await request(P.root, { method: "HEAD" })).status).toBe(200);
  });
});
