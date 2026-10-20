// Download routes (implementation slice 3 steps 4–5, plan §6): bytes, headers, If-None-Match,
// HEAD, the text/plain 404 / 405 and the 500s of a store that cannot back its catalog, through
// createApp().request() on a seeded MemoryStore. What only a real socket shows (HEAD
// Content-Length on the wire, Transfer-Encoding) is tests/integration/downloads.test.ts. The
// "store get throws" case migrates worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts:27-39.
import { describe, expect, it } from "vitest";
import { checkConfigState, checkConfigStatic } from "../../src/core/admin.ts";
import { CATALOG_KEY, certificateBlobKey, CONFIG_KEY } from "../../src/core/catalog.ts";
import { derToPem, PEM_BLOCK_MARKERS } from "../../src/core/pki/pem.ts";
import type { PemBlockMarkers } from "../../src/core/pki/pem.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, manifest } from "../fixtures/pki.ts";
import { logRecords, patchStore, putText, testDeps } from "../helpers/app.ts";
import type { LogLine } from "../helpers/app.ts";
import { cert, putConfig } from "../helpers/catalog.ts";
import { DOWNLOAD_PATHS, SEED_CRLS, seedDownloads } from "../helpers/seed-downloads.ts";
import type { DownloadSeed, DownloadSeedOptions } from "../helpers/seed-downloads.ts";
import { opaqueEtagStore } from "../helpers/store.ts";

const P = DOWNLOAD_PATHS;
const ROOT = cert("root-ca");
const ISSUING = cert("issuing-ca-1");
const UUID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const INDEX_HTML = "<!doctype html><title>UI</title>";
const IMMUTABLE = "public, max-age=31536000, immutable";
const DOCUMENT_KEYS = [CATALOG_KEY, CONFIG_KEY].sort();

/** Hono's secureHeaders defaults without HSTS (B8): on every response. */
const SECURE_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
};

function crlEntry(file: string) {
  const found = manifest.crls.find((entry) => entry.file === file);
  if (!found) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found;
}

const FULL = crlEntry(SEED_CRLS.full);

function pemBytes(der: Uint8Array, { begin, end }: PemBlockMarkers): Uint8Array {
  return new TextEncoder().encode(derToPem(der, begin, end));
}

/** The store key of a target's current CRL in the seed. */
function crlKey(seed: DownloadSeed, role: "full" | "delta"): string {
  const current = seed.catalog.targets[seed.targets[role]]?.current;
  if (!current) {
    throw new Error(`the seed has no current CRL for ${role}`);
  }
  return current.key;
}

interface Served {
  path: string;
  /** What GET sends: the DER fixture, or OpenSSL's PEM of it where the fixtures have one. */
  body: Uint8Array;
  /** The one blob GET reads. */
  key: (seed: DownloadSeed) => string;
}

const SERVED: Served[] = [
  { path: P.root, body: fixture(ROOT.der), key: () => certificateBlobKey(ROOT.sha256) },
  { path: `${P.root}.pem`, body: fixture(ROOT.pem), key: () => certificateBlobKey(ROOT.sha256) },
  { path: P.nested, body: fixture(ROOT.der), key: () => certificateBlobKey(ROOT.sha256) },
  {
    path: `${P.nested}.pem`,
    body: fixture(ROOT.pem),
    key: () => certificateBlobKey(ROOT.sha256),
  },
  { path: P.issuing, body: fixture(ISSUING.der), key: () => certificateBlobKey(ISSUING.sha256) },
  {
    path: `${P.issuing}.pem`,
    body: fixture(ISSUING.pem),
    key: () => certificateBlobKey(ISSUING.sha256),
  },
  { path: P.full, body: fixture(SEED_CRLS.full), key: (seed) => crlKey(seed, "full") },
  {
    path: `${P.full}.pem`,
    body: fixture(SEED_CRLS.full.replace(/\.der$/, ".pem")),
    key: (seed) => crlKey(seed, "full"),
  },
  { path: P.delta, body: fixture(SEED_CRLS.delta), key: (seed) => crlKey(seed, "delta") },
  {
    path: `${P.delta}.pem`,
    body: pemBytes(fixture(SEED_CRLS.delta), PEM_BLOCK_MARKERS.crl),
    key: (seed) => crlKey(seed, "delta"),
  },
];

interface SetupOptions extends DownloadSeedOptions {
  /** `get` of these keys throws (after being counted). */
  failGet?: (key: string) => boolean;
}

/**
 * createApp on a MemoryStore holding the seed, behind two wrappers: store ETags that are not the
 * digest (opaqueEtagStore: a download ETag can only come from the catalog, B14) and a recorder of
 * every `get` key. `ui` records the paths it is asked for and answers with the SPA's index.html.
 */
async function setup(options: SetupOptions = {}) {
  const { failGet, ...seedOptions } = options;
  const base = new MemoryStore();
  const seed = await seedDownloads(base, seedOptions);
  const opaque = opaqueEtagStore(base);
  const gets: string[] = [];
  const store = patchStore(
    {
      get: async (key) => {
        gets.push(key);
        if (failGet?.(key)) {
          throw new Error(`private storage details of ${key}`);
        }
        return opaque.get(key);
      },
    },
    opaque
  );
  const uiPaths: string[] = [];
  const deps = testDeps({
    store,
    ui: (req) => {
      uiPaths.push(new URL(req.url).pathname);
      return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
  const app = createApp(deps);
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://localhost${path}`, init);
  const blobGets = () => gets.filter((key) => key !== CONFIG_KEY && key !== CATALOG_KEY);
  /** Clears the recorded gets and ui calls (between requests of one test). */
  const reset = () => {
    gets.length = 0;
    uiPaths.length = 0;
  };
  return { app, deps, seed, base, request, gets, blobGets, uiPaths, reset };
}

/** Every response header but Date, by lowercase name, in sorted order. */
function headerSnapshot(res: Response): Record<string, string> {
  return Object.fromEntries(
    [...res.headers].filter(([name]) => name !== "date").sort(([a], [b]) => a.localeCompare(b))
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

function errorLines(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => line.level === "error");
}

function requestLines(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => line.msg === "request");
}

describe("the seed", () => {
  it("passes the static and state config rules", async () => {
    const { seed } = await setup();
    expect(checkConfigStatic(seed.config).ok).toBe(true);
    expect(checkConfigState(seed.config, seed.catalog)).toEqual([]);
  });
});

describe("bytes", () => {
  it.each(SERVED)("GET $path sends the stored DER or the PEM derived from it", async (served) => {
    const { request, seed, gets, uiPaths } = await setup();
    const res = await request(served.path);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(served.body);
    // config.json and catalog.json once each, then the one blob (step 4).
    expect([...gets].sort()).toEqual([...DOCUMENT_KEYS, served.key(seed)].sort());
    expect(uiPaths).toEqual([]);
  });

  it("serves two paths of one certificate from one blob, with one ETag", async () => {
    const { request, blobGets, reset } = await setup();
    const responses = [];
    for (const path of [P.root, P.rootAlias]) {
      reset();
      const res = await request(path);
      expect(res.status, path).toBe(200);
      expect(blobGets(), path).toEqual([certificateBlobKey(ROOT.sha256)]);
      responses.push({
        etag: res.headers.get("ETag"),
        disposition: res.headers.get("Content-Disposition"),
        body: await bytesOf(res),
      });
    }
    const [a, b] = responses;
    expect(a?.etag).toBe(`"${ROOT.sha256}"`);
    expect(b?.etag).toBe(a?.etag);
    expect(b?.body).toEqual(a?.body);
    expect(a?.disposition).toBe('attachment; filename="root-ca.crt"');
    expect(b?.disposition).toBe('attachment; filename="root.cer"');
  });

  it("ignores Range: the whole body, 200", async () => {
    const { request } = await setup();
    const res = await request(P.root, { headers: { Range: "bytes=0-9" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await bytesOf(res)).toEqual(fixture(ROOT.der));
  });
});

describe("headers", () => {
  it("snapshot: certificate DER, GET", async () => {
    const { request, seed } = await setup();
    const res = await request(P.root);
    expect(res.status).toBe(200);
    expect(headerSnapshot(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt"',
      "content-length": String(fixture(ROOT.der).byteLength),
      "content-type": "application/pkix-cert",
      etag: `"${ROOT.sha256}"`,
      "last-modified": httpDate(seed.catalog.certificates[ROOT.sha256]?.importedAt),
      ...SECURE_HEADERS,
    });
  });

  it("snapshot: certificate PEM, HEAD", async () => {
    const { request, seed } = await setup();
    const res = await request(`${P.root}.pem`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(headerSnapshot(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt.pem"',
      "content-length": String(fixture(ROOT.pem).byteLength),
      "content-type": "application/x-pem-file",
      etag: `"${ROOT.sha256}-pem"`,
      "last-modified": httpDate(seed.catalog.certificates[ROOT.sha256]?.importedAt),
      ...SECURE_HEADERS,
    });
  });

  it("snapshot: CRL DER, GET (nextUpdate 4 days after NOW → max-age 3600)", async () => {
    const { request, seed } = await setup();
    const res = await request(P.full);
    expect(res.status).toBe(200);
    expect(headerSnapshot(res)).toEqual({
      "cache-control": "public, max-age=3600, must-revalidate",
      "content-disposition": 'attachment; filename="issuing-ca-1.crl"',
      "content-length": String(fixture(SEED_CRLS.full).byteLength),
      "content-type": "application/pkix-crl",
      etag: `"${FULL.sha256}"`,
      "last-modified": httpDate(seed.catalog.targets[seed.targets.full]?.current?.publishedAt),
      ...SECURE_HEADERS,
    });
  });

  it("snapshot: 304 carries ETag and Cache-Control only", async () => {
    const { request } = await setup();
    const res = await request(P.root, { headers: { "If-None-Match": `"${ROOT.sha256}"` } });
    expect(res.status).toBe(304);
    expect(headerSnapshot(res)).toEqual({
      "cache-control": IMMUTABLE,
      etag: `"${ROOT.sha256}"`,
      ...SECURE_HEADERS,
    });
    expect(await res.text()).toBe("");
  });

  it("never sends HSTS, edge cache directives or filename*", async () => {
    const { request } = await setup();
    const responses = [await request(P.root, { headers: { "If-None-Match": `"${ROOT.sha256}"` } })];
    for (const { path } of SERVED) {
      for (const method of ["GET", "HEAD"]) {
        responses.push(await request(path, { method }));
      }
    }
    for (const res of responses) {
      expect(res.headers.get("Strict-Transport-Security")).toBeNull();
      const all = JSON.stringify([...res.headers]);
      expect(all).not.toContain("s-maxage");
      expect(all).not.toContain("stale-while-revalidate");
      expect(all).not.toContain("filename*");
    }
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

  it.each(SERVED)("HEAD $path: the GET headers, no body, no blob read", async ({ path }) => {
    const { request, gets, blobGets, reset } = await setup();
    const get = await request(path);
    const body = await bytesOf(get);
    reset();
    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(headerSnapshot(head)).toEqual(headerSnapshot(get));
    expect(head.headers.get("Content-Length")).toBe(String(body.byteLength));
    expect(await head.text()).toBe("");
    expect(blobGets()).toEqual([]);
    expect([...gets].sort()).toEqual(DOCUMENT_KEYS);
  });
});

describe("If-None-Match", () => {
  const der = `"${ROOT.sha256}"`;
  const pem = `"${ROOT.sha256}-pem"`;

  it.each([
    ["the exact ETag", P.root, der],
    ["a weak ETag", P.root, `W/${der}`],
    ["a list with spaces", P.root, ` "other" ,  ${der} `],
    ["a list with a weak member", P.root, `"other", W/${der}`],
    ["*", P.root, "*"],
    ["the PEM ETag on the PEM path", `${P.root}.pem`, pem],
    ["the CRL's ETag", P.full, `"${FULL.sha256}"`],
  ])("%s → 304 for GET and HEAD, without reading the blob", async (_, path, header) => {
    const { request, gets, blobGets, uiPaths, reset } = await setup();
    for (const method of ["GET", "HEAD"]) {
      reset();
      const res = await request(path, { method, headers: { "If-None-Match": header } });
      expect(res.status, method).toBe(304);
      expect(await res.text(), method).toBe("");
      expect(res.headers.get("Content-Length"), method).toBeNull();
      expect(res.headers.get("Content-Type"), method).toBeNull();
      expect(blobGets(), method).toEqual([]);
      expect([...gets].sort(), method).toEqual(DOCUMENT_KEYS);
      expect(uiPaths, method).toEqual([]);
    }
  });

  it.each([
    ["another ETag", P.root, `"${ISSUING.sha256}"`],
    ["the PEM ETag on the DER path", P.root, pem],
    ["the DER ETag on the PEM path", `${P.root}.pem`, der],
    ["the digest without quotes (the old service's form)", P.root, ROOT.sha256],
    ["an empty header", P.root, ""],
  ])("%s → 200 with the body", async (_, path, header) => {
    const { request } = await setup();
    const res = await request(path, { headers: { "If-None-Match": header } });
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).byteLength).toBe(Number(res.headers.get("Content-Length")));
  });
});

describe("text/plain 404", () => {
  /**
   * Asserts the download 404: text, no-store, no ui, no read beyond the two documents. Also with
   * `If-None-Match: *`, which only matches a current representation (RFC 9110 §13.1.2): never 304.
   */
  async function expectNotFound(path: string, setupOptions: SetupOptions = {}) {
    const { request, gets, uiPaths } = await setup(setupOptions);
    for (const method of ["GET", "HEAD"]) {
      for (const headers of [{}, { "If-None-Match": "*" }]) {
        const label = `${method} ${path} ${JSON.stringify(headers)}`;
        const res = await request(path, { method, headers });
        expect(res.status, label).toBe(404);
        expect(res.headers.get("Content-Type"), label).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), label).toBe("no-store");
        expect(res.headers.get("ETag"), label).toBeNull();
        expect(await res.text(), label).toBe(method === "GET" ? "Not Found" : "");
      }
    }
    expect(uiPaths).toEqual([]);
    expect(gets.filter((key) => !DOCUMENT_KEYS.includes(key))).toEqual([]);
  }

  it.each([
    ["an unknown path", "/ca/unknown.crt"],
    ["a second .pem", `${P.root}.pem.pem`],
    ["another case", "/ca/Root-CA.crt"],
    ["another case of the extension", "/ca/root-ca.CRT"],
    ["an upper-case .PEM", `${P.root}.PEM`],
    ["an encoded slash in the name", "/ca/a%2Fb.crt"],
    // P.nested is served: decoding %2F (the old code did) would find it.
    ["an encoded slash in a served nested path", "/ca/sub%2Froot-ca.crt"],
    ["a lower-case encoded slash in a served nested path", "/ca/sub%2froot-ca.crt"],
    ["the PEM of a served nested path with an encoded slash", "/ca/sub%2Froot-ca.crt.pem"],
    ["an encoded slash after the prefix", "/ca%2Froot-ca.crt"],
    ["an encoded slash before the name", "/ca/%2Froot-ca.crt"],
    ["a malformed escape", "/ca/%ZZ.crt"],
    ["a malformed escape in a served name", "/ca/root-ca%ZZ.crt"],
    ["a double slash", "/ca//root-ca.crt"],
    ["a leading double slash", "//ca/root-ca.crt"],
    ["a trailing slash", `${P.root}/`],
    ["the prefix with a slash", "/ca/"],
    ["the prefix alone", "/ca"],
    ["/crl alone", "/crl"],
    ["/dcrl/", "/dcrl/"],
    ["a target that was never published", P.unpublished],
    ["the PEM of a target that was never published", `${P.unpublished}.pem`],
    ["a retired target (current null)", P.retired],
    ["the PEM of a retired target", `${P.retired}.pem`],
  ])("%s: %s", async (_, path) => {
    await expectNotFound(path);
  });

  it("treats a missing config.json as an empty path table", async () => {
    const { base, request } = await setup();
    await base.delete(CONFIG_KEY);
    const res = await request(P.root);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it.each([
    ["an escaped dash", "/ca/root%2Dca.crt"],
    ["a dot segment", "/ca/./root-ca.crt"],
    ["an escaped dot segment", "/ca/%2e/root-ca.crt"],
    ["a dot-dot segment", "/ca/x/../root-ca.crt"],
    ["an escaped dot-dot segment", "/ca/x/%2e%2e/root-ca.crt"],
    ["a query string", `${P.root}?a=1`],
  ])("serves a path that URL parsing normalises: %s (%s)", async (_, path) => {
    const { request } = await setup();
    const res = await request(path);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(fixture(ROOT.der));
  });

  describe("internal keys are never reachable", () => {
    // Objects where a server mapping the request path onto a store key (the old one did) would
    // find something: the old layout's archive and by-keyid keys and a blob key under /ca/.
    async function decoyed() {
      const context = await setup();
      const { base, seed } = context;
      const aki = seed.catalog.certificates[ISSUING.sha256]?.summary.subjectKeyId;
      for (const key of [
        "crl/archive/x.crl",
        `crl/by-keyid/${aki}.crl`,
        `ca/${certificateBlobKey(ROOT.sha256)}`,
      ]) {
        await base.put(key, fixture(SEED_CRLS.full));
      }
      return { ...context, aki };
    }

    it("on the download prefixes: text 404, never the ui, no read but the documents", async () => {
      const { request, gets, uiPaths, seed, aki } = await decoyed();
      for (const path of [
        `/ca/${certificateBlobKey(ROOT.sha256)}`,
        `/crl/${crlKey(seed, "full")}`,
        "/crl/archive/x.crl",
        `/crl/by-keyid/${aki}.crl`,
        "/ca/..%2Fconfig.json",
        "/crl/..%2F..%2Fcatalog.json",
        "/dcrl/%2e%2e%2fconfig.json",
      ]) {
        const res = await request(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).toBe("Not Found");
      }
      expect(uiPaths).toEqual([]);
      expect(gets.filter((key) => !DOCUMENT_KEYS.includes(key))).toEqual([]);
    });

    it("elsewhere: the ui's answer (text 404 for a file path), never the store", async () => {
      const { request, gets } = await decoyed();
      for (const path of [
        `/${certificateBlobKey(ROOT.sha256)}`,
        "/config.json",
        "/catalog.json",
        "/ca/../config.json",
        "/ca/%2e%2e/config.json",
      ]) {
        const res = await request(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).toBe("Not Found");
      }
      expect(gets).toEqual([]);
    });
  });
});

describe("text/plain 405", () => {
  it.each(["POST", "PUT", "DELETE", "OPTIONS", "PATCH"])(
    "%s on a download path → 405 Allow: GET, HEAD, before any read",
    async (method) => {
      const { request, gets, uiPaths } = await setup();
      for (const path of [
        P.root,
        `${P.root}.pem`,
        P.full,
        P.delta,
        "/crl/missing.crl",
        "/ca",
        "/ca/",
        "/crl",
        "/dcrl",
      ]) {
        const res = await request(path, { method });
        expect(res.status, path).toBe(405);
        expect(res.headers.get("Allow"), path).toBe("GET, HEAD");
        expect(res.headers.get("Content-Type"), path).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), path).toBe("no-store");
        expect(res.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
        expect(await res.text(), path).toBe("Method Not Allowed");
      }
      expect(gets).toEqual([]);
      expect(uiPaths).toEqual([]);
    }
  );

  it("keeps the JSON envelope for POST /api/v1/health", async () => {
    const { request } = await setup();
    const res = await request("/api/v1/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
  });

  it.each([
    ["not a download prefix", "/cafoo"],
    ["a UI route", `/crls/${UUID}`],
    ["a spelling no route matches", "/ca%2Froot-ca.crt"],
    ["a spelling no route matches", "//crl/x.crl"],
  ])("POST on %s (%s) → text 404, no Allow", async (_, path) => {
    const { request, uiPaths } = await setup();
    const res = await request(path, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
    expect(uiPaths).toEqual([]);
  });
});

describe("500 when the store cannot back what it names", () => {
  /** The 500 envelope, without any detail. */
  async function expectInternal(res: Response) {
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("private");
    expect(text).not.toContain("blobs/");
    return text;
  }

  it("store get throws → 500 internal; the error text only reaches the log", async () => {
    const { request, deps } = await setup({ failGet: () => true });
    for (const method of ["GET", "HEAD"]) {
      const res = await request(P.root, { method });
      const text = await expectInternal(res);
      if (method === "GET") {
        expect(JSON.parse(text)).toEqual({
          error: { code: "internal", message: "Internal server error" },
        });
      }
    }
    const unhandled = logRecords(deps).filter((line) => line.msg === "unhandled_error");
    expect(unhandled).toHaveLength(2);
    expect(unhandled[0]).toMatchObject({ method: "GET", path: P.root });
    expect(JSON.stringify(unhandled[0])).toContain("private storage details");
  });

  it("a failing blob read fails GET only: HEAD and 304 never read it", async () => {
    const { request } = await setup({ failGet: (key) => key.startsWith("blobs/") });
    await expectInternal(await request(P.root));
    expect((await request(P.root, { method: "HEAD" })).status).toBe(200);
    const revalidated = await request(P.root, {
      headers: { "If-None-Match": `"${ROOT.sha256}"` },
    });
    expect(revalidated.status).toBe(304);
  });

  it("blob missing → 500 and download_blob_missing (HEAD still answers from the catalog)", async () => {
    const { base, request, deps } = await setup();
    const key = certificateBlobKey(ROOT.sha256);
    await base.delete(key);
    await expectInternal(await request(`${P.root}?token=s3cret`));
    expect(errorLines(logRecords(deps))).toEqual([
      { level: "error", msg: "download_blob_missing", path: P.root, key },
    ]);
    expect(requestLines(logRecords(deps))).toMatchObject([{ path: P.root, status: 500 }]);
    expect(deps.lines.join("\n")).not.toContain("s3cret");
    expect((await request(P.root, { method: "HEAD" })).status).toBe(200);
  });

  it.each([
    ["shorter", (der: Uint8Array) => der.subarray(1)],
    ["longer", (der: Uint8Array) => Uint8Array.from([...der, 0])],
  ])("blob %s than the catalog's size → 500 and download_size_mismatch", async (_, change) => {
    const { base, seed, request, deps } = await setup();
    const key = crlKey(seed, "full");
    const der = fixture(SEED_CRLS.full);
    const stored = change(der);
    await base.put(key, stored);
    for (const path of [P.full, `${P.full}.pem`]) {
      await expectInternal(await request(path));
    }
    expect(errorLines(logRecords(deps))).toEqual(
      [P.full, `${P.full}.pem`].map((path) => ({
        level: "error",
        msg: "download_size_mismatch",
        path,
        key,
        size: der.byteLength,
        actual: stored.byteLength,
      }))
    );
  });

  // The path table names what the catalog or config does not hold (a delete racing applyConfig,
  // an out-of-band write): never served from elsewhere, never hidden behind a 404.
  it.each([
    ["a certificate the catalog does not hold", "/ca/leaf-min.crt", "certificate"],
    ["a target config.targets does not define", "/crl/dangling.crl", "target"],
  ])("a path to %s → 500 and download_inconsistent, GET and HEAD", async (_, path, field) => {
    const { base, seed, request, deps, blobGets } = await setup();
    const reference =
      field === "certificate"
        ? { certificate: cert("leaf-min").sha256 }
        : { target: crypto.randomUUID() };
    await putConfig(base, { ...seed.config, paths: { ...seed.config.paths, [path]: reference } });
    await expectInternal(await request(path));
    for (const method of ["GET", "HEAD"]) {
      const res = await request(`${path}.pem`, { method });
      expect(res.status, method).toBe(500);
      expect(res.headers.get("Cache-Control"), method).toBe("no-store");
    }
    expect(blobGets()).toEqual([]);
    expect(errorLines(logRecords(deps))).toEqual(
      [path, `${path}.pem`, `${path}.pem`].map((logged) => ({
        level: "error",
        msg: "download_inconsistent",
        path: logged,
        ...reference,
      }))
    );
  });

  it.each([
    ["config.json is not JSON", CONFIG_KEY, "{"],
    ["config.json does not match its schema", CONFIG_KEY, '{"version":2}'],
    ["catalog.json is not JSON", CATALOG_KEY, "{"],
  ])("%s → 500 internal, logged as unhandled", async (_, key, text) => {
    const { base, request, deps } = await setup();
    await putText(base, key, text);
    await expectInternal(await request(P.root));
    expect(errorLines(logRecords(deps))).toMatchObject([
      { msg: "unhandled_error", error: { name: "InvalidStoredObjectError" } },
    ]);
  });
});
