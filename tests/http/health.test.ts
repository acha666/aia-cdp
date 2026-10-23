import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { logRecords, MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";

async function health(config?: string) {
  const store = new MemoryStore();
  if (config !== undefined) {
    await putText(store, "config.json", config);
  }
  const res = await createApp(testDeps({ store })).request("/api/v1/health");
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  return res.json();
}

describe("GET /api/v1/health", () => {
  it("is degraded with configuration missing on an empty store", async () => {
    expect(await health()).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "missing" },
    });
  });

  it("is healthy with the minimal configuration", async () => {
    expect(await health(MINIMAL_CONFIG)).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it.each(["{not json", '{"version":1,"certificates":{},"targets":{},"pahts":{}}'])(
    "is degraded / invalid for config.json %j",
    async (text) => {
      expect(await health(text)).toEqual({
        status: "degraded",
        checks: { store: "ok", configuration: "invalid" },
      });
    }
  );

  it("is 503 unhealthy when the store throws; the error only goes to the log", async () => {
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
    expect(logRecords(deps).filter((line) => line.level === "error")).toEqual([
      {
        level: "error",
        msg: "health_store_error",
        error: { name: "Error", message: "EACCES /data secret" },
      },
    ]);
  });
});
