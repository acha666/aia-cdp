// ObjectStore conformance suite (plan §5.4; implementation slice 1, tests ①–⑫). Every adapter runs
// the same cases; the factory hands each case an empty store.
import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "../../src/core/store.ts";

/** Counterexamples for assertStoreKey, shared with tests/core/store-keys.test.ts. */
export const INVALID_KEYS: readonly string[] = [
  "",
  "/a",
  "a//b",
  "../a",
  "a/./b",
  ".a",
  "a\\b",
  "a\0b",
  // Also rejected: trailing slash, `..` segment, dot-leading inner segment, absolute Windows path.
  "a/",
  "a/../b",
  "blobs/.tmp",
  "C:\\x",
];

/** Counterexamples for assertStorePrefix, shared with tests/core/store-keys.test.ts. */
export const INVALID_PREFIXES: readonly string[] = [
  "blobs",
  "/a/",
  "a//",
  "../",
  "./",
  "a\\b/",
  "a\0/",
  "/",
  "a/b",
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

async function text(store: ObjectStore, key: string): Promise<string | null> {
  const object = await store.get(key);
  return object ? decoder.decode(object.bytes) : null;
}

export function describeObjectStore(
  name: string,
  factory: () => ObjectStore | Promise<ObjectStore>
): void {
  describe(`ObjectStore conformance: ${name}`, () => {
    let store: ObjectStore;

    beforeEach(async () => {
      store = await factory();
    });

    it("① returns null for a missing key and deletes it without error", async () => {
      expect(await store.get("config.json")).toBeNull();
      expect(await store.get("blobs/certificates/missing.der")).toBeNull();
      await expect(store.delete("config.json")).resolves.toBeUndefined();
      await expect(store.delete("blobs/certificates/missing.der")).resolves.toBeUndefined();
      expect(await store.list("")).toEqual([]);
    });

    it("② stores bytes unconditionally and reports the same ETag", async () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      const result = await store.put("blobs/certificates/a.der", bytes);
      if (!result.ok) {
        throw new Error("unconditional put failed");
      }
      expect(result.etag).toEqual(expect.any(String));

      const got = await store.get("blobs/certificates/a.der");
      expect(got).not.toBeNull();
      expect(Array.from(got!.bytes)).toEqual([0, 1, 2, 253, 254, 255]);
      expect(got!.etag).toBe(result.etag);

      // Unconditional puts replace.
      const second = await store.put("blobs/certificates/a.der", bytesOf("replaced"));
      expect(second.ok).toBe(true);
      expect(await text(store, "blobs/certificates/a.der")).toBe("replaced");
    });

    it("③ isolates stored bytes from the caller's input and output buffers", async () => {
      const input = bytesOf("original");
      expect((await store.put("catalog.json", input)).ok).toBe(true);
      input.fill(0x21);
      expect(await text(store, "catalog.json")).toBe("original");

      const output = (await store.get("catalog.json"))!.bytes;
      output.fill(0x3f);
      expect(await text(store, "catalog.json")).toBe("original");
    });

    it('④ creates with ifNoneMatch: "*" only when the key is missing', async () => {
      const first = await store.put("catalog.json", bytesOf("first"), { ifNoneMatch: "*" });
      expect(first.ok).toBe(true);
      const before = await store.get("catalog.json");

      expect(await store.put("catalog.json", bytesOf("second"), { ifNoneMatch: "*" })).toEqual({
        ok: false,
        reason: "precondition-failed",
      });
      expect(await text(store, "catalog.json")).toBe("first");
      expect(await store.get("catalog.json")).toEqual(before);
    });

    it("⑤ replaces with ifMatch on the current ETag (from put or get) and changes it", async () => {
      const created = await store.put("catalog.json", bytesOf("v1"), { ifNoneMatch: "*" });
      if (!created.ok) {
        throw new Error("create failed");
      }

      const fromPut = await store.put("catalog.json", bytesOf("v2"), { ifMatch: created.etag });
      if (!fromPut.ok) {
        throw new Error("ifMatch with the ETag returned by put failed");
      }
      expect(fromPut.etag).not.toBe(created.etag);
      expect(await text(store, "catalog.json")).toBe("v2");

      const got = (await store.get("catalog.json"))!;
      expect(got.etag).toBe(fromPut.etag);
      const fromGet = await store.put("catalog.json", bytesOf("v3"), { ifMatch: got.etag });
      if (!fromGet.ok) {
        throw new Error("ifMatch with the ETag returned by get failed");
      }
      expect(fromGet.etag).not.toBe(got.etag);
      expect(await store.get("catalog.json")).toEqual({
        bytes: expect.anything() as unknown,
        etag: fromGet.etag,
      });
      expect(await text(store, "catalog.json")).toBe("v3");
    });

    it("⑥ refuses a stale ifMatch and keeps the content", async () => {
      const created = await store.put("catalog.json", bytesOf("v1"));
      if (!created.ok) {
        throw new Error("put failed");
      }
      const updated = await store.put("catalog.json", bytesOf("v2"), { ifMatch: created.etag });
      expect(updated.ok).toBe(true);
      const before = await store.get("catalog.json");

      expect(await store.put("catalog.json", bytesOf("v3"), { ifMatch: created.etag })).toEqual({
        ok: false,
        reason: "precondition-failed",
      });
      expect(await text(store, "catalog.json")).toBe("v2");
      expect(await store.get("catalog.json")).toEqual(before);
    });

    it("⑦ refuses ifMatch on a missing key", async () => {
      const elsewhere = await store.put("config.json", bytesOf("v1"));
      if (!elsewhere.ok) {
        throw new Error("put failed");
      }
      // A real ETag (of another key) and an empty one: neither may create the key.
      for (const ifMatch of [elsewhere.etag, ""]) {
        expect(await store.put("catalog.json", bytesOf("v1"), { ifMatch })).toEqual({
          ok: false,
          reason: "precondition-failed",
        });
      }
      expect(await store.get("catalog.json")).toBeNull();
      expect((await store.list("")).map((object) => object.key)).toEqual(["config.json"]);
    });

    it("⑧ lets exactly one of five concurrent puts with the same ifMatch win", async () => {
      const created = await store.put("catalog.json", bytesOf("base"));
      if (!created.ok) {
        throw new Error("put failed");
      }
      // Distinct payloads, all different from the current content: ETags follow the content, so
      // identical writes would all "succeed" against the unchanged ETag.
      const payloads = ["w0", "w1", "w2", "w3", "w4"];
      const results = await Promise.all(
        payloads.map((payload) =>
          store.put("catalog.json", bytesOf(payload), { ifMatch: created.etag })
        )
      );

      const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (!result.ok) {
          expect(result).toEqual({ ok: false, reason: "precondition-failed" });
        }
      }
      const winner = winners[0]!;
      const got = (await store.get("catalog.json"))!;
      expect(decoder.decode(got.bytes)).toBe(payloads[winner]);
      expect(got.etag).toBe((results[winner] as { etag: string }).etag);
    });

    it("⑨ lists a prefix recursively, with sizes, sorted by key", async () => {
      const objects: Record<string, string> = {
        "history/t1/20260104000000Z-3-ab.json": "{}",
        "blobs/crls/t1/20260104000000Z-3-ab.der": "crl-3",
        "blobsX/stray.der": "x",
        "config.json": '{"version":1}',
        "blobs/certificates/ff.der": "cert-ff",
        "blobs/crls/t1/20260103000000Z-none-cd.der": "crl",
        "blobs/certificates/0a.der": "c0a",
        "catalog.json": "[]",
      };
      for (const [key, value] of Object.entries(objects)) {
        expect((await store.put(key, bytesOf(value))).ok).toBe(true);
      }
      const expected = (prefix: string) =>
        Object.keys(objects)
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key, size: encoder.encode(objects[key]).byteLength }));

      expect(await store.list("blobs/")).toEqual(expected("blobs/"));
      expect((await store.list("blobs/")).map((object) => object.key)).toEqual([
        "blobs/certificates/0a.der",
        "blobs/certificates/ff.der",
        "blobs/crls/t1/20260103000000Z-none-cd.der",
        "blobs/crls/t1/20260104000000Z-3-ab.der",
      ]);
      expect(await store.list("blobs/crls/t1/")).toEqual(expected("blobs/crls/t1/"));
      expect(await store.list("history/")).toEqual(expected("history/"));
      expect(await store.list("blobsX/")).toEqual([{ key: "blobsX/stray.der", size: 1 }]);
      expect(await store.list("nothing/")).toEqual([]);
      expect(await store.list("")).toEqual(expected(""));
      expect(await store.list("")).toHaveLength(8);
    });

    it("⑩ hides a deleted key from get and list", async () => {
      expect((await store.put("blobs/certificates/a.der", bytesOf("a"))).ok).toBe(true);
      expect((await store.put("blobs/certificates/b.der", bytesOf("bb"))).ok).toBe(true);

      await store.delete("blobs/certificates/a.der");
      expect(await store.get("blobs/certificates/a.der")).toBeNull();
      expect(await store.list("blobs/")).toEqual([{ key: "blobs/certificates/b.der", size: 2 }]);
      expect(await store.list("")).toEqual([{ key: "blobs/certificates/b.der", size: 2 }]);
      await expect(store.delete("blobs/certificates/a.der")).resolves.toBeUndefined();

      // The key can be created again afterwards.
      const recreated = await store.put("blobs/certificates/a.der", bytesOf("a2"), {
        ifNoneMatch: "*",
      });
      expect(recreated.ok).toBe(true);
    });

    it("⑪ rejects invalid keys and prefixes with TypeError and leaves the store unchanged", async () => {
      expect((await store.put("config.json", bytesOf("keep"))).ok).toBe(true);
      const before = await store.list("");

      for (const key of INVALID_KEYS) {
        await expect(store.get(key), `get(${JSON.stringify(key)})`).rejects.toThrow(TypeError);
        await expect(store.put(key, bytesOf("x")), `put(${JSON.stringify(key)})`).rejects.toThrow(
          TypeError
        );
        await expect(
          store.put(key, bytesOf("x"), { ifNoneMatch: "*" }),
          `put(${JSON.stringify(key)}, ifNoneMatch)`
        ).rejects.toThrow(TypeError);
        await expect(store.delete(key), `delete(${JSON.stringify(key)})`).rejects.toThrow(
          TypeError
        );
      }
      for (const prefix of INVALID_PREFIXES) {
        await expect(store.list(prefix), `list(${JSON.stringify(prefix)})`).rejects.toThrow(
          TypeError
        );
      }

      expect(await store.list("")).toEqual(before);
      expect(await text(store, "config.json")).toBe("keep");
    });

    it("⑫ keeps put semantics when a contentType is given", async () => {
      const contentType = "application/pkix-crl";
      const created = await store.put("blobs/crls/t1/x.der", bytesOf("crl-1"), {
        contentType,
        ifNoneMatch: "*",
      });
      if (!created.ok) {
        throw new Error("create with contentType failed");
      }
      expect(
        await store.put("blobs/crls/t1/x.der", bytesOf("crl-2"), { contentType, ifNoneMatch: "*" })
      ).toEqual({ ok: false, reason: "precondition-failed" });

      const replaced = await store.put("blobs/crls/t1/x.der", bytesOf("crl-22"), {
        contentType,
        ifMatch: created.etag,
      });
      if (!replaced.ok) {
        throw new Error("replace with contentType failed");
      }
      expect(await store.get("blobs/crls/t1/x.der")).toEqual({
        bytes: expect.anything() as unknown,
        etag: replaced.etag,
      });
      expect(await text(store, "blobs/crls/t1/x.der")).toBe("crl-22");
      expect(
        await store.put("blobs/crls/t1/x.der", bytesOf("crl-3"), {
          contentType,
          ifMatch: created.etag,
        })
      ).toEqual({ ok: false, reason: "precondition-failed" });
    });
  });
}
