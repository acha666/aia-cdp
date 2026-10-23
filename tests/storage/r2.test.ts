// R2Store against Miniflare's R2 through wrangler's getPlatformProxy, with AIA_TEST_R2=1
// (`pnpm run test:r2`, part of `ci:worker`). One proxy is one bucket, so every case starts by
// emptying it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlatformProxy } from "wrangler";
import { R2Store } from "../../src/storage/r2.ts";
import type { R2BucketLike } from "../../src/storage/r2.ts";
import { describeObjectStore } from "./conformance.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe.runIf(process.env.AIA_TEST_R2 === "1")("R2Store via getPlatformProxy", () => {
  let proxy: PlatformProxy<{ STORE: R2BucketLike }> | undefined;
  let store: R2Store;

  beforeAll(async () => {
    // Loaded only here, so that a run without AIA_TEST_R2 never starts workerd; the variables go
    // first, as wrangler reads them when it loads.
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.WRANGLER_HIDE_BANNER = "true";
    const { getPlatformProxy } = await import("wrangler");
    proxy = await getPlatformProxy<{ STORE: R2BucketLike }>({
      configPath: "wrangler.jsonc",
      persist: false,
    });
    store = new R2Store(proxy.env.STORE);
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
  });

  beforeEach(async () => {
    for (const object of await store.list("")) {
      await store.delete(object.key);
    }
  });

  describeObjectStore("r2 (getPlatformProxy)", () => store);

  // R2 lists at most 1000 objects per call.
  it("follows list cursors across 1001 keys", { timeout: 60_000 }, async () => {
    const keys = Array.from(
      { length: 1001 },
      (_, index) => `blobs/certificates/${String(index).padStart(4, "0")}.der`
    );
    for (let start = 0; start < keys.length; start += 50) {
      const batch = keys.slice(start, start + 50);
      const results = await Promise.all(batch.map((key) => store.put(key, bytes(key))));
      expect(results.every((result) => result.ok)).toBe(true);
    }
    const listed = await store.list("blobs/");
    expect(listed.map((object) => object.key)).toEqual(keys);
    expect(listed.every((object) => object.size === 27)).toBe(true);

    // Leave an empty bucket without making the next beforeEach delete 1001 keys one by one.
    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(keys.slice(start, start + 50).map((key) => store.delete(key)));
    }
  });
});
