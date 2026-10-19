import { describe, expect, it } from "vitest";
import { checkHealth } from "../../src/core/health.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { MINIMAL_CONFIG, patchStore, putText } from "../helpers/app.ts";

async function storeWithConfig(text: string): Promise<MemoryStore> {
  const store = new MemoryStore();
  await putText(store, "config.json", text);
  return store;
}

describe("checkHealth", () => {
  it("reports a missing config.json as degraded", async () => {
    expect(await checkHealth(new MemoryStore())).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "missing" },
    });
  });

  it("reports the minimal configuration as healthy", async () => {
    expect(await checkHealth(await storeWithConfig(MINIMAL_CONFIG))).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it.each(["not json", '{"version":2}', "[]", "null", '{"version":"1"}', "1"])(
    "reports config.json %j as degraded / invalid",
    async (text) => {
      expect(await checkHealth(await storeWithConfig(text))).toEqual({
        status: "degraded",
        checks: { store: "ok", configuration: "invalid" },
      });
    }
  );

  it("treats bytes that are not UTF-8 as invalid", async () => {
    const store = new MemoryStore();
    await store.put("config.json", Uint8Array.of(0x7b, 0xff, 0x7d));
    expect((await checkHealth(store)).checks.configuration).toBe("invalid");
  });

  it("reports a throwing head as unhealthy / unknown and hands the error over", async () => {
    const failure = new Error("EACCES /data");
    const errors: unknown[] = [];
    const store = patchStore({
      head: () => Promise.reject(failure),
    });
    expect(await checkHealth(store, (error) => errors.push(error))).toEqual({
      status: "unhealthy",
      checks: { store: "error", configuration: "unknown" },
    });
    expect(errors).toEqual([failure]);
  });

  it("reports a throwing get after a successful head as unhealthy", async () => {
    const base = await storeWithConfig(MINIMAL_CONFIG);
    const store = patchStore({ get: () => Promise.reject(new Error("read failed")) }, base);
    expect(await checkHealth(store)).toEqual({
      status: "unhealthy",
      checks: { store: "error", configuration: "unknown" },
    });
  });

  it("treats config.json deleted between head and get as missing", async () => {
    const base = await storeWithConfig(MINIMAL_CONFIG);
    const store = patchStore({ get: () => Promise.resolve(null) }, base);
    expect((await checkHealth(store)).checks.configuration).toBe("missing");
  });
});
