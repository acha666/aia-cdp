// R2Store runs the conformance suite on every run against the fake bucket, and with AIA_TEST_R2=1
// (`pnpm run test:r2`, part of `ci:worker`) against Miniflare's R2 through wrangler's
// getPlatformProxy. One proxy is one bucket, so every case starts by emptying it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlatformProxy } from "wrangler";
import { R2Store } from "../../src/storage/r2.ts";
import type { R2BucketLike } from "../../src/storage/r2.ts";
import { describeObjectStore } from "./conformance.ts";
import { FakeR2Bucket } from "./fakes/r2-bucket.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Forwards to `bucket`, counting list() pages. */
function countingBucket(bucket: R2BucketLike): { bucket: R2BucketLike; pages: () => number } {
  let pages = 0;
  return {
    bucket: {
      get: (key) => bucket.get(key),
      put: (key, value, options) => bucket.put(key, value, options),
      list: (options) => {
        pages += 1;
        return bucket.list(options);
      },
      delete: (key) => bucket.delete(key),
    },
    pages: () => pages,
  };
}

describeObjectStore("r2 (fake bucket)", () => new R2Store(new FakeR2Bucket()));
describeObjectStore(
  "r2 (fake bucket, 2 objects per list page)",
  () => new R2Store(new FakeR2Bucket({ pageSize: 2 }))
);

describe("R2Store on the fake bucket", () => {
  it("follows list cursors across pages", async () => {
    const bucket = new FakeR2Bucket({ pageSize: 2 });
    const store = new R2Store(bucket);
    const keys = ["p/e", "p/a", "p/d", "q/x", "p/c", "p/b"];
    for (const key of keys) {
      expect((await store.put(key, bytes(key))).ok).toBe(true);
    }
    const before = bucket.listCalls;
    expect(await store.list("p/")).toEqual(
      ["p/a", "p/b", "p/c", "p/d", "p/e"].map((key) => ({ key, size: 3 }))
    );
    expect(bucket.listCalls - before).toBe(3);
  });

  it("passes contentType as httpMetadata and nothing else", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2Store(bucket);
    expect(
      (await store.put("blobs/crls/t/a.der", bytes("a"), { contentType: "application/pkix-crl" }))
        .ok
    ).toBe(true);
    expect((await bucket.get("blobs/crls/t/a.der"))?.httpMetadata).toEqual({
      contentType: "application/pkix-crl",
    });
    expect((await store.put("catalog.json", bytes("{}"))).ok).toBe(true);
    expect((await bucket.get("catalog.json"))?.httpMetadata).toEqual({});
  });

  it("returns R2Object.etag (unquoted), never httpEtag", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2Store(bucket);
    const put = await store.put("catalog.json", bytes("{}"));
    const raw = (await bucket.get("catalog.json"))!;
    expect(raw.httpEtag).toBe(`"${raw.etag}"`);
    expect(put).toEqual({ ok: true, etag: raw.etag });
    expect((await store.get("catalog.json"))?.etag).toBe(raw.etag);
  });

  it("throws TypeError for a quoted ETag instead of failing the precondition", async () => {
    const store = new R2Store(new FakeR2Bucket());
    const put = await store.put("catalog.json", bytes("v1"));
    if (!put.ok) {
      throw new Error("put failed");
    }
    await expect(
      store.put("catalog.json", bytes("v2"), { ifMatch: `"${put.etag}"` })
    ).rejects.toThrow(TypeError);
    expect(text((await store.get("catalog.json"))!.bytes)).toBe("v1");
  });

  it("propagates bucket errors instead of reporting a precondition failure", async () => {
    const failure = new Error("We encountered an internal error. Please try again. (10001)");
    const { bucket } = countingBucket(new FakeR2Bucket());
    const store = new R2Store({ ...bucket, put: () => Promise.reject(failure) });
    await expect(store.put("catalog.json", bytes("{}"), { ifNoneMatch: "*" })).rejects.toBe(
      failure
    );
  });
});

describe.runIf(process.env.AIA_TEST_R2 === "1")("R2Store via getPlatformProxy", () => {
  let proxy: PlatformProxy<{ STORE: R2BucketLike }> | undefined;
  let store: R2Store;
  let pages: () => number;

  beforeAll(async () => {
    // Loaded only here: without AIA_TEST_R2 the suite never starts workerd. Before wrangler is
    // loaded: no telemetry, no banner or update check (implementation §2.4).
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.WRANGLER_HIDE_BANNER = "true";
    const { getPlatformProxy } = await import("wrangler");
    proxy = await getPlatformProxy<{ STORE: R2BucketLike }>({
      configPath: "wrangler.jsonc",
      persist: false,
    });
    const counting = countingBucket(proxy.env.STORE);
    store = new R2Store(counting.bucket);
    pages = counting.pages;
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

  it("throws TypeError for a quoted ETag instead of failing the precondition", async () => {
    const put = await store.put("catalog.json", bytes("v1"));
    if (!put.ok) {
      throw new Error("put failed");
    }
    await expect(
      store.put("catalog.json", bytes("v2"), { ifMatch: `"${put.etag}"` })
    ).rejects.toThrow(TypeError);
    expect(text((await store.get("catalog.json"))!.bytes)).toBe("v1");
  });

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
    const before = pages();
    const listed = await store.list("blobs/");
    expect(pages() - before).toBe(2);
    expect(listed.map((object) => object.key)).toEqual(keys);
    expect(listed.every((object) => object.size === 27)).toBe(true);

    // Leave an empty bucket without making the next beforeEach delete 1001 keys one by one.
    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(keys.slice(start, start + 50).map((key) => store.delete(key)));
    }
    expect(await store.list("")).toEqual([]);
  });
});
