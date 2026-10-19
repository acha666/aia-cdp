// Admin routes (implementation slice 2 step 8, plan §7.2): the token / auth / body-limit gate,
// POST /api/v1/admin/certificates, GET and PUT /api/v1/admin/config. Every status of the step 8
// table, the 428 / 412 split of owner decision 4, and the HTTP ETag = SHA-256 rule (B14).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../../src/core/admin.ts";
import { CATALOG_KEY, CONFIG_KEY, encodeJson } from "../../src/core/catalog.ts";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath, NOW } from "../fixtures/pki.ts";
import { logRecords, MINIMAL_CONFIG, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { cert, certificateEntry } from "../helpers/catalog.ts";
import { flakyStore, opaqueEtagStore, recordingStore, writtenKeys } from "../helpers/store.ts";

const TOKEN = "admin-s3cret-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const CERTIFICATES = "/api/v1/admin/certificates";
const CONFIG = "/api/v1/admin/config";

// What a RequestInit takes (HeadersInit and BodyInit are not globals in the Node program).
type HeaderFields = NonNullable<RequestInit["headers"]>;
type Body = RequestInit["body"];

/** createApp with the admin token set (unless `overrides.settings` says otherwise). */
function setup(overrides: TestOverrides = {}) {
  const deps = testDeps({
    sleep: async () => undefined,
    ...overrides,
    settings: { adminToken: TOKEN, ...overrides.settings },
  });
  return { app: createApp(deps), deps };
}

type App = ReturnType<typeof setup>["app"];

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

function der(name: string): Uint8Array<ArrayBuffer> {
  return fixture(cert(name).der);
}

function post(app: App, body: Body, contentType?: string, headers: HeaderFields = AUTH) {
  const all = new Headers(headers);
  if (contentType !== undefined) {
    all.set("Content-Type", contentType);
  }
  return app.request(CERTIFICATES, { method: "POST", body, headers: all });
}

function put(app: App, body: string | null, headers: Record<string, string>) {
  return app.request(CONFIG, {
    method: "PUT",
    body,
    headers: { ...AUTH, "Content-Type": "application/json", ...headers },
  });
}

async function errorOf(
  res: Response
): Promise<{ code: string; message: string; details?: unknown }> {
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

/** The quoted SHA-256 of `bytes`: the only HTTP ETag the admin routes send. */
async function etagOf(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return `"${await sha256Hex(data)}"`;
}

/** The canonical bytes of MINIMAL_CONFIG, as an apply stores them. */
function minimalBytes(): Uint8Array {
  return encodeJson(JSON.parse(MINIMAL_CONFIG));
}

/** A valid configuration serving root-ca, which must have been imported. */
function rootConfig(label = "Root CA"): Config {
  const id = cert("root-ca").sha256;
  return {
    version: 1,
    certificates: { [id]: { label } },
    targets: {},
    paths: { "/ca/root-ca.crt": { certificate: id } },
  };
}

/** Imports root-ca through the route. */
async function importRoot(app: App): Promise<void> {
  const res = await post(app, der("root-ca"), "application/pkix-cert");
  expect(res.status).toBe(201);
}

/** Applies MINIMAL_CONFIG as the first configuration; returns its ETag. */
async function applyMinimal(app: App): Promise<string> {
  const res = await put(app, MINIMAL_CONFIG, { "If-None-Match": "*" });
  expect(res.status).toBe(200);
  return res.headers.get("ETag") ?? "";
}

describe("admin gate", () => {
  const routes: [method: string, path: string][] = [
    ["POST", CERTIFICATES],
    ["GET", CONFIG],
    ["PUT", CONFIG],
    ["DELETE", CONFIG],
    ["GET", "/api/v1/admin/missing"],
  ];

  it.each(routes)(
    "%s %s → 503 admin_disabled while no token is configured",
    async (method, path) => {
      const { app } = setup({ settings: { adminToken: undefined } });
      for (const headers of [{}, AUTH, { Authorization: "Basic eA==" }]) {
        const res = await app.request(path, { method, headers });
        expect(res.status).toBe(503);
        expect(res.headers.get("Allow")).toBeNull();
        expect(await errorOf(res)).toMatchObject({ code: "admin_disabled" });
      }
    }
  );

  it("answers 503 before reading an oversized body", async () => {
    const { app } = setup({ settings: { adminToken: undefined, maxUploadBytes: 16 } });
    let pulled = false;
    // highWaterMark 0: pull() runs only when someone reads the body.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const res = await app.request(CERTIFICATES, {
      method: "POST",
      body,
      headers: { ...AUTH, "Content-Type": "application/pkix-cert" },
      duplex: "half",
    });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: "admin_disabled" });
    expect(pulled).toBe(false);
  });

  it.each(routes.slice(0, 3))(
    "%s %s → 401 + WWW-Authenticate without a token",
    async (method, path) => {
      const { app } = setup();
      const res = await app.request(path, { method });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm=""');
      expect(await errorOf(res)).toEqual({ code: "unauthorized", message: "Unauthorized" });
    }
  );

  it("answers 401 for a wrong token", async () => {
    const { app } = setup();
    const res = await app.request(CONFIG, { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    expect(await errorOf(res)).toMatchObject({ code: "unauthorized" });
  });

  it.each(["Basic eA==", "Bearer", "Bearer two words", `Bearer ${TOKEN}!`, TOKEN])(
    "answers 400 bad_request for Authorization %j",
    async (authorization) => {
      const { app } = setup();
      const res = await app.request(CONFIG, { headers: { Authorization: authorization } });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: "bad_request", message: "Bad request" });
    }
  );

  it("answers DELETE on the config with 405 + Allow with a valid token, 401 without", async () => {
    const { app } = setup();
    const allowed = await app.request(CONFIG, { method: "DELETE", headers: AUTH });
    expect(allowed.status).toBe(405);
    expect(allowed.headers.get("Allow")).toBe("GET, HEAD, PUT");
    expect(await errorOf(allowed)).toMatchObject({ code: "method_not_allowed" });

    // bearerAuth throws first; methodNotAllowed only rewrites a 404 without an error.
    const anonymous = await app.request(CONFIG, { method: "DELETE" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Allow")).toBeNull();
  });

  it("answers an unknown admin path with the JSON 404 after auth", async () => {
    const { app } = setup();
    const res = await app.request("/api/v1/admin/missing", { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found" });
  });

  it.each([
    ["POST", CERTIFICATES, "application/pkix-cert"],
    ["PUT", CONFIG, "application/json"],
  ])("%s %s → 413 for a body over AIA_MAX_UPLOAD_BYTES", async (method, path, contentType) => {
    const { app, deps } = setup({ settings: { maxUploadBytes: 64 } });
    const body = method === "POST" ? der("root-ca") : `${MINIMAL_CONFIG}${" ".repeat(64)}`;
    const res = await app.request(path, {
      method,
      body,
      headers: { ...AUTH, "Content-Type": contentType, "If-None-Match": "*" },
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({ code: "payload_too_large", message: "Payload too large" });
    expect(await deps.store.list("")).toEqual([]);
  });

  it("never logs the token", async () => {
    const { app, deps } = setup();
    await importRoot(app);
    await post(app, fixture("invalid/garbage.txt"), "application/octet-stream");
    await app.request(CONFIG, { headers: { Authorization: "Bearer wrong-s3cret" } });
    await app.request(CONFIG, { headers: { Authorization: `Basic ${TOKEN}` } });
    await put(app, MINIMAL_CONFIG, { "If-None-Match": "*" });
    await app.request(`${CONFIG}?token=${TOKEN}`, { headers: AUTH });
    const all = deps.lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("wrong-s3cret");
    expect(logRecords(deps).filter((line) => line.msg === "request")).toHaveLength(6);
  });
});

describe("POST /api/v1/admin/certificates", () => {
  it("imports DER as 201 created, then the same certificate as PEM as 200 unchanged", async () => {
    const store = recordingStore();
    const { app, deps } = setup({ store });
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const expected = {
      id,
      size: entry.size,
      importedAt: NOW.toISOString(),
      summary: entry.summary,
    };

    const created = await post(app, der("issuing-ca-1"), "application/pkix-cert");
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(created.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await created.json()).toEqual({ outcome: "created", ...expected });
    expect(writtenKeys(store)).toEqual([entry.key, CATALOG_KEY]);

    const unchanged = await post(app, text(cert("issuing-ca-1").pem), "application/x-pem-file");
    expect(unchanged.status).toBe(200);
    expect(unchanged.headers.get("Cache-Control")).toBe("no-store");
    expect(await unchanged.json()).toEqual({ outcome: "unchanged", ...expected });
    expect(writtenKeys(store)).toHaveLength(2);

    const imports = logRecords(deps).filter((line) => line.msg === "import");
    expect(imports).toEqual([
      { level: "info", msg: "import", certificateId: id, outcome: "created" },
      { level: "info", msg: "import", certificateId: id, outcome: "unchanged" },
    ]);
  });

  it("takes application/octet-stream, with Content-Type parameters, recognizing the bytes", async () => {
    const { app } = setup();
    const pem = await post(app, text(cert("root-ca").pem), "application/octet-stream");
    expect(pem.status).toBe(201);
    const derBody = await post(app, der("issuing-ca-2"), "Application/PKIX-Cert; x=1");
    expect(derBody.status).toBe(201);
    expect(await derBody.json()).toMatchObject({ id: cert("issuing-ca-2").sha256 });
  });

  it("takes the file field `certificate` of a multipart form", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("certificate", new Blob([der("root-ca")]), "root-ca.der");
    const res = await post(app, form);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ outcome: "created", id: cert("root-ca").sha256 });
  });

  it.each<[string, () => FormData]>([
    [
      "a string field",
      () => {
        const form = new FormData();
        form.append("certificate", text(cert("root-ca").pem));
        return form;
      },
    ],
    [
      "another field name",
      () => {
        const form = new FormData();
        form.append("file", new Blob([der("root-ca")]), "root-ca.der");
        return form;
      },
    ],
    [
      "two files",
      () => {
        const form = new FormData();
        form.append("certificate", new Blob([der("root-ca")]), "a.der");
        form.append("certificate", new Blob([der("issuing-ca-1")]), "b.der");
        return form;
      },
    ],
  ])("answers a multipart form with %s with 400", async (_, form) => {
    const { app, deps } = setup();
    const res = await post(app, form());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "bad_request",
      details: { target: "form" },
    });
    expect(await deps.store.list("")).toEqual([]);
  });

  it("answers a multipart form with an empty file with 400", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("certificate", new Blob([]), "empty.der");
    const res = await post(app, form);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "bad_request" });
  });

  it.each<[string, Body, string | undefined]>([
    ["an empty body", fixture("invalid/empty.bin"), "application/pkix-cert"],
    ["no body and no Content-Type", null, undefined],
  ])("answers %s with 400", async (_, body, contentType) => {
    const { app, deps } = setup();
    const res = await post(app, body, contentType);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "bad_request" });
    expect(logRecords(deps).filter((line) => line.msg === "import")).toEqual([]);
  });

  it.each<[string, string | undefined]>([
    ["text/plain", "text/plain"],
    ["application/json", "application/json"],
    ["application/x-x509-ca-cert", "application/x-x509-ca-cert"],
    ["urlencoded", "application/x-www-form-urlencoded"],
    ["no Content-Type", undefined],
  ])("answers a body sent as %s with 415", async (_, contentType) => {
    const { app, deps } = setup();
    const res = await post(app, der("root-ca"), contentType);
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toEqual({
      code: "unsupported_media_type",
      message: "Unsupported media type",
    });
    expect(await deps.store.list("")).toEqual([]);
  });

  it.each<[string, () => Uint8Array<ArrayBuffer> | string, string]>([
    ["garbage", () => fixture("invalid/garbage.txt"), "der"],
    ["a CRL", () => fixture("crls/issuing-ca-1/full-01.der"), "structure"],
    ["a CRL as PEM", () => text("crls/root-ca/full-01.pem"), "pem_label"],
    ["a trailing byte", () => new Uint8Array([...der("root-ca"), 0]), "trailing_bytes"],
    [
      "a two-certificate bundle",
      () => text(cert("issuing-ca-1").pem) + text(cert("root-ca").pem),
      "pem_blocks",
    ],
  ])("answers %s with 422 invalid_certificate and its reason", async (_, body, reason) => {
    const { app, deps } = setup();
    const res = await post(app, body(), "application/octet-stream");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: "invalid_certificate",
      message: "Not a valid X.509 certificate",
      details: { reason },
    });
    expect(await deps.store.list("")).toEqual([]);
    expect(logRecords(deps).filter((line) => line.msg === "import")).toEqual([
      { level: "warn", msg: "import", reason },
    ]);
  });

  it("answers 409 concurrent_update when every catalog write is lost", async () => {
    const base = new MemoryStore();
    const first = setup({ store: base });
    await importRoot(first.app);
    // Four lost conditional writes: 1 attempt + 3 retries (no-op sleep).
    const { app, deps } = setup({ store: flakyStore(base, { failIfMatch: 4 }) });
    const res = await post(app, der("issuing-ca-1"), "application/pkix-cert");
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "concurrent_update" });
    expect(logRecords(deps).filter((line) => line.msg === "import")).toEqual([
      {
        level: "warn",
        msg: "import",
        certificateId: cert("issuing-ca-1").sha256,
        reason: "concurrent_update",
      },
    ]);
  });
});

describe("GET /api/v1/admin/config", () => {
  it("answers 404 while nothing is configured", async () => {
    const { app } = setup();
    const res = await app.request(CONFIG, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found" });
  });

  it("returns the stored bytes as they are, with their SHA-256 as ETag, even when invalid", async () => {
    const store = new MemoryStore();
    const stored = '{"version":1, "tagrets": {}}';
    await putText(store, CONFIG_KEY, stored);
    const { app } = setup({ store });
    const res = await app.request(CONFIG, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBe(await etagOf(stored));
    expect(await res.text()).toBe(stored);

    const head = await app.request(CONFIG, { method: "HEAD", headers: AUTH });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(await etagOf(stored));
    expect(await head.text()).toBe("");
  });
});

describe("PUT /api/v1/admin/config", () => {
  it("applies the first configuration with If-None-Match: *, then replaces it with If-Match", async () => {
    const store = recordingStore();
    const { app } = setup({ store });
    await importRoot(app);

    const first = await put(app, JSON.stringify(rootConfig()), { "If-None-Match": "*" });
    const firstBytes = encodeJson(rootConfig());
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Content-Type")).toBe("application/json");
    expect(first.headers.get("ETag")).toBe(await etagOf(firstBytes));
    // The canonical bytes as stored: GET returns the same.
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(firstBytes);
    expect((await store.get(CONFIG_KEY))?.bytes).toEqual(firstBytes);
    const got = await app.request(CONFIG, { headers: AUTH });
    expect(got.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(firstBytes);

    const second = await put(app, JSON.stringify(rootConfig("Root")), {
      "If-Match": first.headers.get("ETag") ?? "",
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).toBe(await etagOf(encodeJson(rootConfig("Root"))));
    // Only config.json is written by an apply.
    expect(writtenKeys(store).filter((key) => key === CONFIG_KEY)).toHaveLength(2);
    expect(writtenKeys(store).filter((key) => key === CATALOG_KEY)).toHaveLength(1);

    const stale = await put(app, MINIMAL_CONFIG, { "If-Match": first.headers.get("ETag") ?? "" });
    expect(stale.status).toBe(412);
    expect(await errorOf(stale)).toMatchObject({ code: "precondition_failed" });
  });

  it("sends the SHA-256 as ETag, never the store's ETag", async () => {
    const store = opaqueEtagStore();
    const { app } = setup({ store });
    const etag = await applyMinimal(app);
    expect(etag).toBe(await etagOf(minimalBytes()));
    expect((await store.head(CONFIG_KEY))?.etag).toMatch(/^store:/);
    const got = await app.request(CONFIG, { headers: AUTH });
    expect(got.headers.get("ETag")).toBe(etag);
    // The store ETag that was read goes back to the store; the HTTP one never does.
    const again = await put(app, MINIMAL_CONFIG, { "If-Match": etag });
    expect(again.status).toBe(200);
    expect(again.headers.get("ETag")).toBe(etag);
  });

  it("replaces an invalid config.json written out of band, with the If-Match from GET", async () => {
    const store = new MemoryStore();
    await putText(store, CONFIG_KEY, "{not json");
    const { app } = setup({ store });
    const got = await app.request(CONFIG, { headers: AUTH });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("{not json");
    const etag = got.headers.get("ETag") ?? "";
    expect(etag).toBe(await etagOf("{not json"));

    const res = await put(app, MINIMAL_CONFIG, { "If-Match": etag });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(await etagOf(minimalBytes()));
  });

  it.each<[string, Record<string, string>]>([
    ["no precondition", {}],
    ["both preconditions", { "If-Match": '"x"', "If-None-Match": "*" }],
    ["If-None-Match with an ETag", { "If-None-Match": '"x"' }],
    ["If-None-Match: W/*", { "If-None-Match": "W/*" }],
    ["If-None-Match: *, *", { "If-None-Match": "*, *" }],
  ])("answers %s with 428 precondition_required", async (_, headers) => {
    const { app, deps } = setup();
    // Checked before the body: an invalid configuration still gets the 428.
    const res = await put(app, '{"version":2}', headers);
    expect(res.status).toBe(428);
    expect(await errorOf(res)).toMatchObject({ code: "precondition_required" });
    expect(await deps.store.list("")).toEqual([]);
  });

  it.each<[string, (etag: string) => string | Promise<string>]>([
    ["a weak ETag", (etag) => `W/${etag}`],
    ["a list", (etag) => `${etag}, ${etag}`],
    ["an unquoted digest", (etag) => etag.slice(1, -1)],
    ["*", () => "*"],
    ["an uppercase digest", (etag) => etag.toUpperCase()],
    ["the digest of other bytes", () => etagOf(MINIMAL_CONFIG)],
  ])("answers If-Match with %s with 412 precondition_failed", async (_, make) => {
    const { app, deps } = setup();
    const etag = await applyMinimal(app);
    const res = await put(app, '{"version":1,"certificates":{},"targets":{},"paths":{}}', {
      "If-Match": await make(etag),
    });
    expect(res.status).toBe(412);
    expect(await errorOf(res)).toMatchObject({ code: "precondition_failed" });
    expect((await deps.store.get(CONFIG_KEY))?.bytes).toEqual(minimalBytes());
  });

  it("answers If-Match while nothing is configured with 412", async () => {
    const { app, deps } = setup();
    const res = await put(app, MINIMAL_CONFIG, { "If-Match": await etagOf(MINIMAL_CONFIG) });
    expect(res.status).toBe(412);
    expect(await errorOf(res)).toMatchObject({ code: "precondition_failed" });
    expect(await deps.store.get(CONFIG_KEY)).toBeNull();
  });

  it("answers If-None-Match: * once a configuration exists with 412", async () => {
    const { app } = setup();
    await applyMinimal(app);
    const res = await put(app, MINIMAL_CONFIG, { "If-None-Match": "*" });
    expect(res.status).toBe(412);
    expect(await errorOf(res)).toMatchObject({ code: "precondition_failed" });
  });

  it.each<[string, string | null, string | undefined]>([
    ["malformed JSON", "{not json", "application/json"],
    ["an empty JSON body", "", "application/json"],
    ["no body and no Content-Type", null, undefined],
  ])("answers %s with 400 bad_request", async (_, body, contentType) => {
    const { app } = setup();
    const res = await app.request(CONFIG, {
      method: "PUT",
      body,
      headers: {
        ...AUTH,
        "If-None-Match": "*",
        ...(contentType === undefined ? {} : { "Content-Type": contentType }),
      },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "bad_request" });
  });

  it("answers a body that is not JSON by type with 415", async () => {
    const { app } = setup();
    const res = await put(app, MINIMAL_CONFIG, {
      "If-None-Match": "*",
      "Content-Type": "text/plain",
    });
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toMatchObject({ code: "unsupported_media_type" });
  });

  it("answers a schema violation with 422 config_invalid (V1), not the default 400", async () => {
    const { app, deps } = setup();
    const res = await put(app, '{"version":1,"certificates":{},"targets":{},"pahts":{}}', {
      "If-None-Match": "*",
    });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error).toMatchObject({
      code: "config_invalid",
      message: "The configuration is invalid",
    });
    const issues = (error.details as { issues: ConfigIssue[] }).issues;
    expect(issues.map(({ rule, path }) => [rule, path])).toEqual([
      ["V1", ["paths"]],
      ["V1", []],
    ]);
    expect(issues[1]?.message).toBe('Unrecognized key: "pahts"');
    expect(await deps.store.get(CONFIG_KEY)).toBeNull();
  });

  it("answers a rule violation with 422 config_invalid and every issue", async () => {
    const { app, deps } = setup();
    // root-ca is not imported (V4) and the path has a bad character (V2).
    const config = rootConfig();
    config.paths["/ca/root ca.crt"] = { certificate: cert("root-ca").sha256 };
    const res = await put(app, JSON.stringify(config), { "If-None-Match": "*" });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("config_invalid");
    const issues = (error.details as { issues: ConfigIssue[] }).issues;
    expect(issues.map((issue) => [issue.rule, issue.path])).toEqual([
      ["V2", ["paths", "/ca/root ca.crt"]],
      ["V4", ["certificates", cert("root-ca").sha256]],
      ["V4", ["paths", "/ca/root-ca.crt", "certificate"]],
      ["V4", ["paths", "/ca/root ca.crt", "certificate"]],
    ]);
    expect(await deps.store.get(CONFIG_KEY)).toBeNull();
  });

  it("answers 500 without overwriting an invalid catalog.json", async () => {
    const store = new MemoryStore();
    await putText(store, CATALOG_KEY, "{}");
    const { app, deps } = setup({ store });
    const res = await put(app, MINIMAL_CONFIG, { "If-None-Match": "*" });
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: "internal", message: "Internal server error" });
    expect(await store.get(CONFIG_KEY)).toBeNull();
    expect(logRecords(deps).filter((line) => line.msg === "unhandled_error")).toMatchObject([
      { error: { name: "InvalidStoredObjectError" } },
    ]);
  });
});
