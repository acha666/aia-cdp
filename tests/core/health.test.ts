import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../../src/core/catalog.ts";
import { checkHealth } from "../../src/core/health.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { MINIMAL_CONFIG, patchStore, putText } from "../helpers/app.ts";

async function storeWithConfig(text: string): Promise<MemoryStore> {
  const store = new MemoryStore();
  await putText(store, CONFIG_KEY, text);
  return store;
}

describe("checkHealth", () => {
  it("reports a missing config.json as degraded", async () => {
    expect(await checkHealth(new MemoryStore())).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "missing" },
    });
  });

  it("reports the minimal configuration as healthy (catalog.json missing)", async () => {
    expect(await checkHealth(await storeWithConfig(MINIMAL_CONFIG))).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it("reports a config.json that fails its schema as degraded / invalid", async () => {
    const store = await storeWithConfig('{"version":1,"certificates":{},"targets":{}}');
    expect(await checkHealth(store)).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "invalid" },
    });
  });

  it("reports a store error as unhealthy / unknown and hands the error over", async () => {
    const failure = new Error("EACCES /data");
    const errors: unknown[] = [];
    const store = patchStore({ get: () => Promise.reject(failure) });
    expect(await checkHealth(store, (error) => errors.push(error))).toEqual({
      status: "unhealthy",
      checks: { store: "error", configuration: "unknown" },
    });
    expect(errors).toEqual([failure]);
  });
});
