// POST /api/v1/crls (implementation slice 4 step 8, plan §7.1): the route gate (optional bearerAuth
// → media type → bodyLimit, all ahead of the form validator), multipart and raw bodies, every row
// of the step 8 status table with its envelope and details, the log lines, and the route's OpenAPI
// shape. Migrated: worker-aia-cdp@5b570aa:tests/web/api-client.test.ts case 3 (a multipart upload
// keeps the original DER bytes; repeating it is now 200 unchanged instead of an error).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY } from "../../src/core/catalog.ts";
import type { CrlKind } from "../../src/core/catalog.ts";
import { SIGNATURE_ALG_NAMES } from "../../src/core/pki/constants.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { buildCertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { createApp } from "../../src/http/app.ts";
import { CRL_MEDIA_TYPES } from "../../src/http/schemas.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath, manifest } from "../fixtures/pki.ts";
import type { ManifestCrl } from "../fixtures/pki.ts";
import { logRecords, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { cert, currentCrl } from "../helpers/catalog.ts";
import { ISSUING_FULL_ALIAS, setupPublish, targetPath } from "../helpers/publish.ts";
import type { PublishSetup, SetupOptions } from "../helpers/publish.ts";
import { flakyStore, recordingStore } from "../helpers/store.ts";

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

function formWith(...fields: [name: string, value: Blob | string][]): FormData {
  const form = new FormData();
  for (const [name, value] of fields) {
    if (typeof value === "string") {
      form.append(name, value);
    } else {
      form.append(name, value, `${name}.der`);
    }
  }
  return form;
}

async function errorOf(
  res: Response
): Promise<{ code: string; message: string; details?: unknown }> {
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  // Exactly the envelope: no other top-level or error fields.
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error).sort()).toEqual(
    "details" in body.error ? ["code", "details", "message"] : ["code", "message"]
  );
  return body.error;
}

function crlEntry(file: string): ManifestCrl {
  const found = manifest.crls.find((crl) => crl.file === file);
  if (found === undefined) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found;
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

/** `details.current` of a 409 against the fixture `file`. */
function versionOf(file: string) {
  const entry = crlEntry(file);
  return {
    sha256: entry.sha256,
    crlNumber: entry.crlNumber,
    thisUpdate: new Date(entry.thisUpdate).toISOString(),
  };
}

/** The SIGNATURE_ALG_NAMES name of a CRL fixture's signature algorithm. */
function algorithmOf(file: string): string {
  const oid = parseCRL(fixture(file)).signatureAlgorithm.algorithmId;
  return SIGNATURE_ALG_NAMES[oid] ?? oid;
}

/** A body that records whether anyone read it (highWaterMark 0: pull() runs only then). */
function lazyBody(size: number): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { body, pulled: () => pulled };
}

function lazyUpload(app: App, size: number, headers: Record<string, string>) {
  const { body, pulled } = lazyBody(size);
  const res = app.request(CRLS, { method: "POST", body, headers, duplex: "half" });
  return { res, pulled };
}

describe("POST /api/v1/crls: bodies", () => {
  // worker-aia-cdp@5b570aa:tests/web/api-client.test.ts case 3.
  it("publishes the file field crl of a multipart form as sent; the repeat is 200 unchanged", async () => {
    const { app, base, setup } = await service();
    const der = fixture(ROOT_FULL_01);
    const expected = await publishedBody(ROOT_FULL_01, "created", setup);
    expect(expected.downloads).toEqual(["/crl/root-ca.crl", "/crl/root-ca.crl.pem"]);

    const created = await upload(app, formWith(["crl", new Blob([der])]));
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(await created.json()).toEqual(expected);
    const current = await currentCrl(ROOT_FULL_01, expected.target);
    expect((await base.get(current.key))?.bytes).toEqual(der);

    const again = await upload(app, formWith(["crl", new Blob([der])]));
    expect(again.status).toBe(200);
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(await again.json()).toEqual({ ...expected, outcome: "unchanged" });
  });

  it("takes PEM text in the string field crl (pasted, curl -F crl=<file)", async () => {
    const { app, setup } = await service();
    const res = await upload(app, formWith(["crl", text("crls/issuing-ca-1/full-01.pem")]));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(await publishedBody(FULL_01, "created", setup));
  });

  it.each<[string, string, () => Uint8Array<ArrayBuffer> | string]>([
    ["application/pkix-crl", "DER", () => fixture(FULL_01)],
    ["application/x-pem-file", "PEM", () => text("crls/issuing-ca-1/full-01.pem")],
    ["application/octet-stream", "DER", () => fixture(FULL_01)],
    ["application/pkix-crl", "PEM with CRLF", () => text("crls/issuing-ca-1/full-01.crlf.pem")],
    ["application/octet-stream", "PEM", () => text("crls/issuing-ca-1/full-01.pem")],
    ["Application/PKIX-CRL; charset=binary", "DER", () => fixture(FULL_01)],
  ])("takes a raw %s body (%s), recognizing the bytes", async (contentType, _, body) => {
    const { app, setup } = await service();
    const res = await upload(app, body(), contentType);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(await publishedBody(FULL_01, "created", setup));
  });

  it("publishes a delta to the issuer's delta target with its base CRL Number", async () => {
    const { app, setup } = await service();
    const res = await uploadFile(app, DELTA_01);
    expect(res.status).toBe(201);
    const body = await publishedBody(DELTA_01, "created", setup);
    expect(body).toMatchObject({ kind: "delta", baseCrlNumber: crlEntry(DELTA_01).baseCrlNumber });
    expect(await res.json()).toEqual(body);
  });

  it.each<[string, () => FormData]>([
    ["another field name", () => formWith(["file", new Blob([fixture(FULL_01)])])],
    [
      "the field twice",
      () => formWith(["crl", new Blob([fixture(FULL_01)])], ["crl", new Blob([fixture(FULL_02)])]),
    ],
    ["no field", () => new FormData()],
  ])("answers a multipart form with %s with 400 from the form validator", async (_, form) => {
    const { app, deps, base } = await service();
    const before = await base.list("");
    const res = await upload(app, form());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "bad_request",
      details: { target: "form" },
    });
    expect(await base.list("")).toEqual(before);
    expect(logRecords(deps).filter((line) => line.msg === "publish")).toEqual([]);
  });

  it.each<[string, () => FormData]>([
    ["an empty file", () => formWith(["crl", new Blob([])])],
    ["an empty string", () => formWith(["crl", ""])],
  ])("answers the field crl as %s with 400", async (_, form) => {
    const { app, deps } = await service();
    const res = await upload(app, form());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "bad_request",
      message: "Expected a CRL, but the upload is empty",
    });
    expect(logRecords(deps).filter((line) => line.msg === "publish")).toEqual([]);
  });

  it.each<[string, string, Body]>([
    ["a body that is not multipart", "multipart/form-data; boundary=xyz", "garbage"],
    ["no boundary", "multipart/form-data", "garbage"],
    ["an empty body", "multipart/form-data; boundary=xyz", ""],
    [
      "a parameter besides the boundary",
      "multipart/form-data; boundary=xyz; charset=utf-8",
      '--xyz\r\nContent-Disposition: form-data; name="crl"\r\n\r\nx\r\n--xyz--\r\n',
    ],
  ])("answers a malformed multipart request (%s) with 400", async (_, contentType, body) => {
    const { app } = await service();
    const res = await upload(app, body, contentType);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "bad_request" });
  });

  it.each<[string, Body]>([
    ["an empty body", new Uint8Array(0)],
    ["no body", null],
  ])("answers a raw upload with %s with 400", async (_, body) => {
    const { app } = await service();
    const res = await upload(app, body, "application/pkix-crl");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "bad_request",
      message: "Expected a CRL, but the upload is empty",
    });
  });

  it.each<[string, string | undefined, string | null]>([
    ["text/plain", "text/plain; charset=utf-8", "text/plain"],
    ["application/json", "application/json", "application/json"],
    ["urlencoded", "application/x-www-form-urlencoded", "application/x-www-form-urlencoded"],
    ["application/pkix-cert", "application/pkix-cert", "application/pkix-cert"],
    ["no Content-Type", undefined, null],
    ["an empty Content-Type", "", null],
  ])("answers a body sent as %s with 415 and what it received", async (_, type, received) => {
    const { app, base } = await service();
    const before = await base.list("");
    const res = await upload(app, fixture(FULL_01), type);
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toMatchObject({
      code: "unsupported_media_type",
      details: { received, accepted: [...CRL_MEDIA_TYPES] },
    });
    expect(await base.list("")).toEqual(before);
  });
});

describe("POST /api/v1/crls: token, media type and size gate", () => {
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
    const { app, base } = await service({ overrides: { settings: { uploadToken: TOKEN } } });
    const before = await base.list("");
    const res = await uploadFile(app, ROOT_FULL_01, auth);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(challenge);
    expect(await errorOf(res)).toEqual({ code: "unauthorized", message: "Unauthorized" });
    expect(await base.list("")).toEqual(before);
  });

  it.each(["Basic eA==", "Bearer", "Bearer two words", `Bearer ${TOKEN}!`, TOKEN])(
    "answers the malformed Authorization %j with 400 bad_request",
    async (authorization) => {
      const { app } = await service({ overrides: { settings: { uploadToken: TOKEN } } });
      const res = await uploadFile(app, ROOT_FULL_01, { Authorization: authorization });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: "bad_request", message: "Bad request" });
    }
  );

  it("publishes with the right token", async () => {
    const { app, setup } = await service({ overrides: { settings: { uploadToken: TOKEN } } });
    const res = await uploadFile(app, ROOT_FULL_01, AUTH);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(await publishedBody(ROOT_FULL_01, "created", setup));
  });

  // The middleware order of step 8, each step proven by a request that two of them would answer
  // differently.
  it("checks the token before the media type, and both before reading the body", async () => {
    const { app } = await service({
      overrides: { settings: { uploadToken: TOKEN, maxUploadBytes: 16 } },
    });
    const anonymous = lazyUpload(app, 1024, { "Content-Type": "text/plain" });
    expect((await anonymous.res).status).toBe(401);
    expect(anonymous.pulled()).toBe(false);

    const malformed = await upload(app, "x", "text/plain", { Authorization: "Basic eA==" });
    expect(malformed.status).toBe(400);

    const wrongType = lazyUpload(app, 1024, { ...AUTH, "Content-Type": "text/plain" });
    const res = await wrongType.res;
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toMatchObject({ details: { received: "text/plain" } });
    expect(wrongType.pulled()).toBe(false);
  });

  it("checks the media type before the size, without a token as well", async () => {
    const { app } = await service({ overrides: { settings: { maxUploadBytes: 16 } } });
    const wrongType = lazyUpload(app, 1024, { "Content-Type": "application/json" });
    expect((await wrongType.res).status).toBe(415);
    expect(wrongType.pulled()).toBe(false);
  });

  it("answers an oversized multipart form with 413 before the validator sees it", async () => {
    const { app } = await service({ overrides: { settings: { maxUploadBytes: 64 } } });
    // No field crl: the validator would say 400.
    const res = await upload(app, formWith(["file", new Blob([fixture(FULL_01)])]));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({ code: "payload_too_large", message: "Payload too large" });
  });

  it("answers 413 from Content-Length without reading the body", async () => {
    const { app, base } = await service({ overrides: { settings: { maxUploadBytes: 64 } } });
    const before = await base.list("");
    const declared = lazyUpload(app, 1024, {
      "Content-Type": "application/pkix-crl",
      "Content-Length": "1024",
    });
    const res = await declared.res;
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: "payload_too_large" });
    expect(declared.pulled()).toBe(false);
    expect(await base.list("")).toEqual(before);
  });

  it("answers 413 for a streamed body without Content-Length", async () => {
    const { app, base } = await service({ overrides: { settings: { maxUploadBytes: 64 } } });
    const before = await base.list("");
    const streamed = lazyUpload(app, 1024, { "Content-Type": "application/pkix-crl" });
    const res = await streamed.res;
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: "payload_too_large" });
    expect(streamed.pulled()).toBe(true);
    expect(await base.list("")).toEqual(before);
  });

  it("takes a CRL of exactly AIA_MAX_UPLOAD_BYTES", async () => {
    const der = fixture(ROOT_FULL_01);
    const { app } = await service({ overrides: { settings: { maxUploadBytes: der.byteLength } } });
    expect((await upload(app, der, "application/pkix-crl")).status).toBe(201);
  });
});

describe("POST /api/v1/crls: the status table", () => {
  it("answers 200 updated for a newer CRL", async () => {
    const { app, setup } = await service();
    expect((await uploadFile(app, FULL_01)).status).toBe(201);
    const res = await uploadFile(app, FULL_02);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await publishedBody(FULL_02, "updated", setup));
  });

  it.each([
    ["stale_crl", FULL_01, "The CRL is older than the target's current CRL"],
    [
      "conflict",
      "crls/issuing-ca-1/full-02-conflict.der",
      "The target's current CRL has other bytes for the same CRL Number and thisUpdate",
    ],
    [
      "non_orderable",
      "crls/issuing-ca-1/full-no-number.der",
      "Only one of the CRL and the target's current CRL has a CRL Number",
    ],
  ])("answers 409 %s with the current CRL in details", async (code, file, message) => {
    const { app, base } = await service();
    expect((await uploadFile(app, FULL_02)).status).toBe(201);
    const catalog = await base.get(CATALOG_KEY);
    const res = await uploadFile(app, file);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code,
      message,
      details: { current: versionOf(FULL_02) },
    });
    expect((await base.get(CATALOG_KEY))?.bytes).toEqual(catalog?.bytes);
  });

  it("answers 409 concurrent_update without details when every catalog write is lost", async () => {
    const { app, deps } = await service({ wrap: (base) => flakyStore(base, { failIfMatch: 4 }) });
    const res = await uploadFile(app, FULL_01);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: "concurrent_update",
      message: "The catalog kept changing concurrently: retry the upload",
    });
    expect(logRecords(deps).filter((line) => line.msg === "publish")).toEqual([
      expect.objectContaining({ level: "warn", reason: "concurrent_update", attempts: 4 }),
    ]);
  });

  const unknownCriticalOid =
    /critical ([0-9.]+)/.exec(crlEntry("crls/issuing-ca-1/full-unknown-critical.der").note)?.[1] ??
    "";

  it.each<[string, string, string, () => unknown]>([
    ["invalid_crl", "invalid/garbage.txt", "Not a valid X.509 CRL", () => ({ reason: "der" })],
    [
      "invalid_crl",
      "crls/issuing-ca-1/full-bad-time.der",
      "Not a valid X.509 CRL",
      () => ({ reason: "time" }),
    ],
    [
      "not_yet_valid",
      "crls/issuing-ca-1/full-future.der",
      "The CRL's thisUpdate is more than 5 minutes ahead of the service's clock",
      () => ({
        thisUpdate: new Date(
          crlEntry("crls/issuing-ca-1/full-future.der").thisUpdate
        ).toISOString(),
      }),
    ],
    [
      "unknown_critical_extension",
      "crls/issuing-ca-1/full-unknown-critical.der",
      "The CRL has a critical extension this service does not know",
      () => ({ oid: unknownCriticalOid }),
    ],
    [
      "scoped_crl_unsupported",
      "crls/issuing-ca-1/full-idp-scoped.der",
      "Scoped and indirect CRLs are not supported",
      // The Issuing Distribution Point extension.
      () => ({ oid: "2.5.29.28" }),
    ],
    [
      "unsupported_algorithm",
      "crls/ed25519-ca/full-01.der",
      "The CRL's signature algorithm is not supported",
      () => ({ algorithm: algorithmOf("crls/ed25519-ca/full-01.der") }),
    ],
    [
      "issuer_not_found",
      "crls/rogue-ca/full-01.der",
      "No imported certificate has the CRL's Authority Key Identifier as its Subject Key Identifier",
      async () => {
        const rogue = fixture(cert("rogue-ca").der);
        const { subjectKeyId } = await buildCertificateSummary(parseCertificate(rogue), rogue);
        return { authorityKeyId: subjectKeyId };
      },
    ],
    [
      "issuer_not_found",
      "crls/issuing-ca-1/full-no-aki.der",
      "The CRL has no Authority Key Identifier keyIdentifier",
      () => ({ reason: "missing_aki" }),
    ],
    [
      "invalid_signature",
      "crls/issuing-ca-1/full-broken-sig.der",
      "The CRL's signature does not verify with the issuer's key",
      () => ({ algorithm: algorithmOf("crls/issuing-ca-1/full-broken-sig.der") }),
    ],
  ])("answers 422 %s for %s", async (code, file, message, details) => {
    const { app, base, deps } = await service();
    const before = await base.list("");
    const res = await uploadFile(app, file);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({ code, message, details: await details() });
    expect(await base.list("")).toEqual(before);
    expect(logRecords(deps).filter((line) => line.msg === "publish")).toEqual([
      expect.objectContaining({ level: "warn", msg: "publish", reason: code }),
    ]);
  });

  it("answers 422 target_not_configured with the kind and the matching certificates", async () => {
    const { app } = await service({
      setup: { targets: [{ issuer: "issuing-ca-1", kind: "full" }] },
    });
    const res = await uploadFile(app, DELTA_01);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: "target_not_configured",
      message: "No configured target of the CRL's kind names its issuer",
      details: { kind: "delta", certificates: [cert("issuing-ca-1").sha256] },
    });
  });

  it("answers 500 internal without the exception text when the store fails", async () => {
    const secret = "disk on fire at /var/lib/secret-path";
    const { app, deps } = await service({
      wrap: (base) => flakyStore(base, { putError: new Error(secret) }),
    });
    const res = await uploadFile(app, FULL_01);
    expect(res.status).toBe(500);
    const text = await res.clone().text();
    expect(text).not.toContain("disk on fire");
    expect(await errorOf(res)).toEqual({ code: "internal", message: "Internal server error" });
    const records = logRecords(deps);
    // The call's publish line, onError's line with the stack, and the request line.
    expect(records.map((line) => line.msg)).toEqual(["publish", "unhandled_error", "request"]);
    expect(records[0]).toMatchObject({
      level: "error",
      reason: "internal",
      detail: expect.stringContaining(secret) as unknown,
    });
    expect(records[2]).toMatchObject({ method: "POST", path: CRLS, status: 500 });
  });
});

describe("POST /api/v1/crls: logs", () => {
  it("logs one publish and one request line per upload, never the token", async () => {
    const { app, deps, setup } = await service({
      overrides: { settings: { uploadToken: TOKEN } },
    });
    await uploadFile(app, ROOT_FULL_01, AUTH);
    await uploadFile(app, ROOT_FULL_01, AUTH);
    await uploadFile(app, ROOT_FULL_01, { Authorization: "Bearer wrong-s3cret" });
    await uploadFile(app, "crls/root-ca/full-01.der", { Authorization: `Basic ${TOKEN}` });
    const records = logRecords(deps);
    expect(records.filter((line) => line.msg === "request").map((line) => line.status)).toEqual([
      201, 200, 401, 400,
    ]);
    const entry = crlEntry(ROOT_FULL_01);
    expect(records.filter((line) => line.msg === "publish")).toEqual(
      ["created", "unchanged"].map((outcome) => ({
        level: "info",
        msg: "publish",
        targetId: setup.target("root-ca", "full"),
        kind: "full",
        outcome,
        sha256: entry.sha256,
        crlNumber: entry.crlNumber,
        thisUpdate: new Date(entry.thisUpdate).toISOString(),
        expired: false,
        attempts: 1,
        ms: expect.any(Number) as unknown,
      }))
    );
    const all = deps.lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("wrong-s3cret");
  });

  it("writes the blob and catalog.json only, nothing for a rejection", async () => {
    const base = new MemoryStore();
    await setupPublish(base);
    const store = recordingStore(base);
    const app = createApp(testDeps({ store }));
    await uploadFile(app, "crls/issuing-ca-1/full-broken-sig.der");
    expect(store.writes).toEqual([]);
    await uploadFile(app, ROOT_FULL_01);
    expect(store.writes.map((write) => write.op === "put" && write.key)).toEqual([
      expect.stringMatching(/^blobs\/crls\//),
      CATALOG_KEY,
    ]);
  });
});

describe("POST /api/v1/crls: OpenAPI", () => {
  interface Operation {
    operationId: string;
    security: unknown;
    requestBody: { required?: boolean; content: Record<string, { schema: unknown }> };
    responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }>;
  }
  interface Document {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  }

  async function document(): Promise<Document> {
    const app = createApp(testDeps());
    return (await (await app.request("/api/v1/openapi.json")).json()) as Document;
  }

  /** Every `code` enum value reachable from a component schema, following $refs. */
  function codes(doc: Document, name: string): string[] {
    const found = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node === null || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        visit(doc.components.schemas[record.$ref.replace("#/components/schemas/", "")]);
        return;
      }
      const code = (record.properties as Record<string, { enum?: string[] }> | undefined)?.code;
      for (const value of code?.enum ?? []) {
        found.add(value);
      }
      Object.values(record).forEach(visit);
    };
    visit(doc.components.schemas[name]);
    return [...found].sort();
  }

  it("documents the multipart field crl as one binary string, and the raw types", async () => {
    const doc = await document();
    const operation = doc.paths[CRLS]?.post;
    expect(operation?.operationId).toBe("uploadCrl");
    expect(operation?.requestBody.required).toBe(false);
    expect(Object.keys(operation?.requestBody.content ?? {})).toEqual([...CRL_MEDIA_TYPES]);
    expect(operation?.requestBody.content["multipart/form-data"]?.schema).toEqual({
      $ref: "#/components/schemas/CrlUpload",
    });
    expect(doc.components.schemas.CrlUpload).toEqual({
      type: "object",
      properties: {
        crl: {
          type: "string",
          format: "binary",
          description: "The CRL: a DER or PEM file, or PEM text",
        },
      },
      required: ["crl"],
    });
    expect(operation?.security).toEqual([{}, { uploadBearer: [] }]);
    expect(doc.components.securitySchemes.uploadBearer).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("declares exactly the statuses of the step 8 table, codes narrowed per status", async () => {
    const doc = await document();
    const responses = doc.paths[CRLS]?.post?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(
      ["200", "201", "400", "401", "409", "413", "415", "422", "500"].sort()
    );
    const schemaOf = (status: string) =>
      responses[status]?.content["application/json"]?.schema.$ref.replace(
        "#/components/schemas/",
        ""
      ) ?? "";
    expect(schemaOf("200")).toBe("PublishedCrl");
    expect(schemaOf("201")).toBe("PublishedCrl");
    expect(codes(doc, schemaOf("400"))).toEqual(["bad_request"]);
    expect(codes(doc, schemaOf("401"))).toEqual(["unauthorized"]);
    expect(codes(doc, schemaOf("409"))).toEqual(
      ["concurrent_update", "conflict", "non_orderable", "stale_crl"].sort()
    );
    expect(codes(doc, schemaOf("413"))).toEqual(["payload_too_large"]);
    expect(codes(doc, schemaOf("415"))).toEqual(["unsupported_media_type"]);
    expect(codes(doc, schemaOf("422"))).toEqual(
      [
        "invalid_crl",
        "not_yet_valid",
        "unknown_critical_extension",
        "scoped_crl_unsupported",
        "unsupported_algorithm",
        "issuer_not_found",
        "target_not_configured",
        "invalid_signature",
      ].sort()
    );
    expect(codes(doc, schemaOf("500"))).toEqual(["internal"]);
    // Owner answer 4: uploads never produce issuer_mismatch.
    expect(JSON.stringify(doc.paths[CRLS])).not.toContain("issuer_mismatch");
    expect(JSON.stringify(doc.components.schemas.CrlRejectedError)).not.toContain(
      "issuer_mismatch"
    );
  });

  it("is the same document whether or not an upload token is set", async () => {
    const withToken = createApp(testDeps({ settings: { uploadToken: TOKEN } }));
    const res = await withToken.request("/api/v1/openapi.json");
    expect(await res.json()).toEqual(await document());
  });
});
