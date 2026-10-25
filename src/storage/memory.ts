// In-memory ObjectStore for tests. ETag = content SHA-256. The conditional check and the write
// happen synchronously after the only await, so two concurrent conditional puts cannot both
// succeed.
import { sha256Hex } from "../core/digest.ts";
import { assertStoreKey, assertStorePrefix } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
}

export class MemoryStore implements ObjectStore {
  readonly #objects = new Map<string, StoredObject>();

  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> {
    assertStoreKey(key);
    const object = this.#objects.get(key);
    return object ? { bytes: object.bytes.slice(), etag: object.etag } : null;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    assertStoreKey(key);
    // Copy before the await so later changes to the caller's buffer cannot leak in.
    const copy = bytes.slice();
    const etag = await sha256Hex(copy);
    // No await from here to the write: of several concurrent puts with the same ifMatch, only
    // the first to resume sees the old ETag.
    const current = this.#objects.get(key);
    if (opts.ifNoneMatch === "*" && current !== undefined) {
      return { ok: false, reason: "precondition-failed" };
    }
    if (opts.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
      return { ok: false, reason: "precondition-failed" };
    }
    this.#objects.set(key, { bytes: copy, etag });
    return { ok: true, etag };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    return [...this.#objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: object.bytes.byteLength }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    assertStoreKey(key);
    this.#objects.delete(key);
  }
}
