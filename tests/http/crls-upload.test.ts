// POST /api/v1/crls: raw bodies, the optional upload token, the media type and size limits, and
// the status, code and message of every publish outcome.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY } from "../../src/core/catalog.ts";
import type { CrlKind } from "../../src/core/catalog.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { createApp } from "../../src/http/app.ts";
import { CRL_MEDIA_TYPES } from "../../src/http/schemas.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath } from "../fixtures/pki.ts";
import { testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { cert, crlEntry, currentCrl } from "../helpers/catalog.ts";
import { ISSUING_FULL_ALIAS, setupPublish, targetPath } from "../helpers/publish.ts";
import type { PublishSetup, SetupOptions } from "../helpers/publish.ts";
import { errorOf, expectInternal } from "../helpers/reads.ts";
import { flakyStore } from "../helpers/store.ts";

const CRLS = "/api/v1/crls";
const TOKEN = "upload-s3cret-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ROOT_FULL_01 = "crls/root-ca/full-01.der";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";

// What a RequestInit takes (HeadersInit and BodyInit are not globals in the Node program).
type HeaderFields = NonNullable<RequestInit["headers"]>;
type Body = RequestInit["body"];

interface ServiceOptions {
  /** Default: the shared setup of tests/helpers/publish.ts (every target of DEFAULT_TARGETS). */
  setup?: SetupOptions;
  /** Wraps the store the setup wrote, for the app only. */
  wrap?: (base: ObjectStore) => ObjectStore;
  overrides?: TestOverrides;
}

/** Certificates imported and targets applied on a MemoryStore, then createApp over it. */
async function service(options: ServiceOptions = {}) {
  const base = new MemoryStore();
  const setup = await setupPublish(base, options.setup);
  const store = options.wrap?.(base) ?? base;
  const deps = testDeps({ sleep: async () => undefined, ...options.overrides, store });
  return { app: createApp(deps), deps, base, setup };
}

type App = Awaited<ReturnType<typeof service>>["app"];

function upload(app: App, body: Body, contentType?: string, headers: HeaderFields = {}) {
  const all = new Headers(headers);
  if (contentType !== undefined) {
    all.set("Content-Type", contentType);
  }
  return app.request(CRLS, { method: "POST", body, headers: all });
}

function uploadFile(app: App, file: string, headers: HeaderFields = {}) {
  return upload(app, fixture(file), "application/pkix-crl", headers);
}

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

/** The download paths of a target of the shared setup (ISSUING_FULL_ALIAS sorts first). */
function downloadsOf(issuer: string, kind: CrlKind): string[] {
  const path = targetPath({ issuer, kind });
  const paths = issuer === "issuing-ca-1" && kind === "full" ? [ISSUING_FULL_ALIAS, path] : [path];
  return paths.flatMap((each) => [each, `${each}.pem`]);
}

/** The success body for the CRL fixture `file` (a .der) published to its target in `setup`. */
async function publishedBody(file: string, outcome: string, setup: PublishSetup) {
  const entry = crlEntry(file);
  const target = setup.target(entry.issuer, entry.kind);
  const current = await currentCrl(file, target);
  const { crlNumber, baseCrlNumber, thisUpdate, nextUpdate } = current.summary;
  return {
    outcome,
    target,
    kind: entry.kind,
    sha256: entry.sha256,
    crlNumber,
    baseCrlNumber,
    thisUpdate,
    nextUpdate,
    issuer: cert(entry.issuer).sha256,
    downloads: downloadsOf(entry.issuer, entry.kind),
  };
}

describe("POST /api/v1/crls: bodies", () => {
  it("publishes the body as sent; the repeat is 200 unchanged", async () => {
    const { app, base, setup } = await service();
    const der = fixture(ROOT_FULL_01);
    const expected = await publishedBody(ROOT_FULL_01, "created", setup);
    expect(expected.downloads).toEqual(["/crl/root-ca.crl", "/crl/root-ca.crl.pem"]);

    const created = await upload(app, der, "application/pkix-crl");
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(await created.json()).toEqual(expected);
    const current = await currentCrl(ROOT_FULL_01, expected.target);
    expect((await base.get(current.key))?.bytes).toEqual(der);

    const again = await upload(app, der, "application/pkix-crl");
    expect(again.status).toBe(200);
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(await again.json()).toEqual({ ...expected, outcome: "unchanged" });
  });

  it.each<[string, string, () => Uint8Array<ArrayBuffer> | string]>([
    ["application/x-pem-file", "PEM", () => text("crls/issuing-ca-1/full-01.pem")],
    ["application/pkix-crl", "PEM with CRLF", () => text("crls/issuing-ca-1/full-01.crlf.pem")],
    ["application/octet-stream", "DER", () => fixture(FULL_01)],
  ])("takes a raw %s body (%s), recognizing the bytes", async (contentType, _, body) => {
    const { app, setup } = await service();
    const res = await upload(app, body(), contentType);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(await publishedBody(FULL_01, "created", setup));
  });

  it.each<[string, Body]>([
    ["an empty body", new Uint8Array(0)],
    ["no body", null],
  ])("answers a raw upload with %s with 400", async (_, body) => {
    const { app } = await service();
    const res = await upload(app, body, "application/pkix-crl");
    expect(await errorOf(res, 400, "bad_request")).toEqual({
      code: "bad_request",
      message: "Expected a CRL, but the upload is empty",
    });
  });

  it.each<[string, string | undefined, string | null]>([
    ["text/plain", "text/plain; charset=utf-8", "text/plain"],
    ["multipart/form-data", "multipart/form-data; boundary=xyz", "multipart/form-data"],
    ["no Content-Type", undefined, null],
  ])("answers a body sent as %s with 415 and what it received", async (_, type, received) => {
    const { app, base } = await service();
    const before = await base.list("");
    const res = await upload(app, fixture(FULL_01), type);
    expect(await errorOf(res, 415, "unsupported_media_type")).toMatchObject({
      code: "unsupported_media_type",
      details: { received, accepted: [...CRL_MEDIA_TYPES] },
    });
    expect(await base.list("")).toEqual(before);
  });
});

describe("POST /api/v1/crls: token and size", () => {
  it("needs no token while AIA_UPLOAD_TOKEN is unset, and ignores an Authorization header", async () => {
    const { app } = await service();
    expect((await uploadFile(app, ROOT_FULL_01)).status).toBe(201);
    const res = await uploadFile(app, FULL_01, { Authorization: "Basic eA==" });
    expect(res.status).toBe(201);
  });

  it.each<[string, Record<string, string>, string]>([
    ["no token", {}, 'Bearer realm=""'],
    ["a wrong token", { Authorization: "Bearer wrong-token" }, 'Bearer error="invalid_token"'],
  ])("answers %s with 401 + WWW-Authenticate once a token is set", async (_, auth, challenge) => {
    const { app, base, setup } = await service({ overrides: { settings: { uploadToken: TOKEN } } });
    const before = await base.list("");
    const res = await uploadFile(app, ROOT_FULL_01, auth);
    expect(res.headers.get("WWW-Authenticate")).toBe(challenge);
    expect(await errorOf(res, 401, "unauthorized")).toMatchObject({ message: "Unauthorized" });
    expect(await base.list("")).toEqual(before);

    const authorized = await uploadFile(app, ROOT_FULL_01, AUTH);
    expect(authorized.status).toBe(201);
    expect(await authorized.json()).toEqual(await publishedBody(ROOT_FULL_01, "created", setup));
  });

  // An anonymous client never gets its body read, nor a 413 that tells it the limit.
  it("checks the token, then the media type, then the size", async () => {
    const settings = { uploadToken: TOKEN, maxUploadBytes: 16 };
    const { app } = await service({ overrides: { settings } });
    const body = () => new Uint8Array(1024);
    expect((await upload(app, body(), "text/plain")).status).toBe(401);
    expect((await upload(app, body(), "text/plain", AUTH)).status).toBe(415);
    expect((await upload(app, body(), "application/pkix-crl", AUTH)).status).toBe(413);
  });

  it("answers 413 for a streamed body without Content-Length over AIA_MAX_UPLOAD_BYTES", async () => {
    const { app, base } = await service({ overrides: { settings: { maxUploadBytes: 64 } } });
    const before = await base.list("");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = await app.request(CRLS, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/pkix-crl" },
      duplex: "half",
    });
    expect(await errorOf(res, 413, "payload_too_large")).toMatchObject({
      message: "Payload too large",
    });
    expect(await base.list("")).toEqual(before);
  });
});

describe("POST /api/v1/crls: outcomes", () => {
  it("answers 200 updated for a newer CRL", async () => {
    const { app, setup } = await service();
    expect((await uploadFile(app, FULL_01)).status).toBe(201);
    const res = await uploadFile(app, FULL_02);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await publishedBody(FULL_02, "updated", setup));
  });

  // The 409 rows upload against full-02 as the target's current CRL.
  it.each([
    [409, "stale_crl", FULL_01, "The CRL is older than the target's current CRL"],
    [
      409,
      "conflict",
      "crls/issuing-ca-1/full-02-conflict.der",
      "The target's current CRL has other bytes for the same CRL Number and thisUpdate",
    ],
    [
      409,
      "non_orderable",
      "crls/issuing-ca-1/full-no-number.der",
      "Only one of the CRL and the target's current CRL has a CRL Number",
    ],
    [422, "invalid_crl", "invalid/garbage.txt", "Not a valid X.509 CRL"],
    [
      422,
      "not_yet_valid",
      "crls/issuing-ca-1/full-future.der",
      "The CRL's thisUpdate is more than 5 minutes ahead of the service's clock",
    ],
    [
      422,
      "unknown_critical_extension",
      "crls/issuing-ca-1/full-unknown-critical.der",
      "The CRL has a critical extension this service does not know",
    ],
    [
      422,
      "scoped_crl_unsupported",
      "crls/issuing-ca-1/full-idp-scoped.der",
      "Scoped and indirect CRLs are not supported",
    ],
    [
      422,
      "unsupported_algorithm",
      "crls/ed25519-ca/full-01.der",
      "The CRL's signature algorithm is not supported",
    ],
    [
      422,
      "issuer_not_found",
      "crls/rogue-ca/full-01.der",
      "No imported certificate has the CRL's Authority Key Identifier as its Subject Key Identifier",
    ],
    [
      422,
      "issuer_not_found",
      "crls/issuing-ca-1/full-no-aki.der",
      "The CRL has no Authority Key Identifier keyIdentifier",
    ],
    [
      422,
      "invalid_signature",
      "crls/issuing-ca-1/full-broken-sig.der",
      "The CRL's signature does not verify with the issuer's key",
    ],
  ])("answers %i %s for %s, writing nothing", async (status, code, file, message) => {
    const { app, base } = await service();
    if (status === 409) {
      expect((await uploadFile(app, FULL_02)).status).toBe(201);
    }
    const before = await base.list("");
    const catalog = (await base.get(CATALOG_KEY))?.bytes;
    const res = await uploadFile(app, file);
    const error = await errorOf(res, status, code);
    expect(error.message).toBe(message);
    if (status === 409) {
      const current = crlEntry(FULL_02);
      expect(error.details).toEqual({
        current: {
          sha256: current.sha256,
          crlNumber: current.crlNumber,
          thisUpdate: new Date(current.thisUpdate).toISOString(),
        },
      });
    }
    expect(await base.list("")).toEqual(before);
    expect((await base.get(CATALOG_KEY))?.bytes).toEqual(catalog);
  });

  it("answers 422 target_not_configured with the kind and the matching certificates", async () => {
    const { app } = await service({
      setup: { targets: [{ issuer: "issuing-ca-1", kind: "full" }] },
    });
    const res = await uploadFile(app, DELTA_01);
    expect(await errorOf(res, 422, "target_not_configured")).toEqual({
      code: "target_not_configured",
      message: "No configured target of the CRL's kind names its issuer",
      details: { kind: "delta", certificates: [cert("issuing-ca-1").sha256] },
    });
  });

  it("answers 409 concurrent_update without details when every catalog write is lost", async () => {
    const { app } = await service({ wrap: (base) => flakyStore(base, { failIfMatch: 4 }) });
    const res = await uploadFile(app, FULL_01);
    expect(await errorOf(res, 409, "concurrent_update")).toEqual({
      code: "concurrent_update",
      message: "The catalog kept changing concurrently: retry the upload",
    });
  });

  it("answers 500 internal without the exception text when the store fails", async () => {
    const secret = "disk on fire at /var/lib/secret-path";
    const { app } = await service({
      wrap: (base) => flakyStore(base, { putError: new Error(secret) }),
    });
    await expectInternal(await uploadFile(app, FULL_01), "disk on fire");
  });
});
