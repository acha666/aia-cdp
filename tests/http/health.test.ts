import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture } from "../fixtures/pki.ts";
import { logRecords, MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";
import { cert } from "../helpers/catalog.ts";

async function health(store = new MemoryStore()) {
  const deps = testDeps({ store });
  const res = await createApp(deps).request("/api/v1/health");
  return { res, body: await res.json(), deps };
}

async function configured(text: string): Promise<MemoryStore> {
  const store = new MemoryStore();
  await putText(store, "config.json", text);
  return store;
}

describe("GET /api/v1/health", () => {
  it("is degraded with configuration missing on an empty store", async () => {
    const { res, body } = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(body).toEqual({ status: "degraded", checks: { store: "ok", configuration: "missing" } });
  });

  it("is healthy with the minimal configuration", async () => {
    const { res, body } = await health(await configured(MINIMAL_CONFIG));
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "healthy", checks: { store: "ok", configuration: "ok" } });
  });

  it.each([
    "{not json",
    '{"version":2}',
    // A misspelled key (the schema is strict).
    '{"version":1,"certificates":{},"targets":{},"pahts":{}}',
    // A path to a certificate that was never imported (V4).
    JSON.stringify({
      version: 1,
      certificates: {},
      targets: {},
      paths: { "/ca/root-ca.crt": { certificate: cert("root-ca").sha256 } },
    }),
  ])("is degraded / invalid for config.json %j", async (text) => {
    const { res, body } = await health(await configured(text));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "invalid" },
    });
  });

  it("is healthy once the certificate is imported and the configuration applied", async () => {
    const token = "admin-token";
    const app = createApp(testDeps({ settings: { adminToken: token } }));
    const auth = { Authorization: `Bearer ${token}` };
    const imported = await app.request("/api/v1/admin/certificates", {
      method: "POST",
      body: fixture(cert("root-ca").der),
      headers: { ...auth, "Content-Type": "application/pkix-cert" },
    });
    expect(imported.status).toBe(201);
    const id = cert("root-ca").sha256;
    const applied = await app.request("/api/v1/admin/config", {
      method: "PUT",
      body: JSON.stringify({
        version: 1,
        certificates: { [id]: { label: "Root CA" } },
        targets: {},
        paths: { "/ca/root-ca.crt": { certificate: id } },
      }),
      headers: { ...auth, "Content-Type": "application/json", "If-None-Match": "*" },
    });
    expect(applied.status).toBe(200);
    const res = await app.request("/api/v1/health");
    expect(await res.json()).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it("is 503 unhealthy when the store throws, without leaking the error", async () => {
    const deps = testDeps({
      store: patchStore({ get: () => Promise.reject(new Error("EACCES /data secret")) }),
    });
    const res = await createApp(deps).request("/api/v1/health");
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({
      status: "unhealthy",
      checks: { store: "error", configuration: "unknown" },
    });
    expect(text).not.toMatch(/EACCES|secret/);

    const errors = logRecords(deps).filter((line) => line.level === "error");
    expect(errors).toEqual([
      {
        level: "error",
        msg: "health_store_error",
        error: { name: "Error", message: "EACCES /data secret" },
      },
    ]);
  });

  it("answers HEAD with 200 and no body", async () => {
    const res = await createApp(testDeps()).request("/api/v1/health", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });
});
