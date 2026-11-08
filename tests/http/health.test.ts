import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { logRecords, MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";
import { okJson } from "../helpers/reads.ts";

describe("GET /api/v1/health", () => {
  it.each([
    ["degraded", "missing", "an empty store", undefined],
    ["healthy", "ok", "the minimal configuration", MINIMAL_CONFIG],
    ["degraded", "invalid", "config.json that is no JSON", "{not json"],
  ])("is %s / %s for %s", async (status, configuration, _, config) => {
    const store = new MemoryStore();
    if (config !== undefined) {
      await putText(store, "config.json", config);
    }
    const res = await createApp(testDeps({ store })).request("/api/v1/health");
    expect(await okJson(res)).toEqual({ status, checks: { store: "ok", configuration } });
  });

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
