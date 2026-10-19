// Store wrappers for write assertions (implementation §2.5, slice 2 tests): recordingStore logs
// every write attempt in order, flakyStore makes conditional writes lose or puts throw. Both wrap
// any ObjectStore and can be stacked: recordingStore(flakyStore(base, …)) records the lost puts.
import type { ObjectStore, PutOptions, PutResult } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { patchStore } from "./app.ts";

export type StoreWrite =
  { op: "put"; key: string; opts: PutOptions; result: PutResult } | { op: "delete"; key: string };

export interface RecordingStore extends ObjectStore {
  /** Every put (with its result) and delete, in call order; a put that throws is not listed. */
  writes: StoreWrite[];
}

export function recordingStore(base: ObjectStore = new MemoryStore()): RecordingStore {
  const writes: StoreWrite[] = [];
  return {
    ...patchStore(
      {
        put: async (key, bytes, opts = {}) => {
          const result = await base.put(key, bytes, opts);
          writes.push({ op: "put", key, opts, result });
          return result;
        },
        delete: async (key) => {
          await base.delete(key);
          writes.push({ op: "delete", key });
        },
      },
      base
    ),
    writes,
  };
}

/** The puts in order, without store ETags: `{ key, opts, ok }`. */
export function puts(store: RecordingStore): { key: string; opts: PutOptions; ok: boolean }[] {
  return store.writes.flatMap((write) =>
    write.op === "put" ? [{ key: write.key, opts: write.opts, ok: write.result.ok }] : []
  );
}

/** The keys of the puts that succeeded, in order. */
export function writtenKeys(store: RecordingStore): string[] {
  return puts(store).flatMap((put) => (put.ok ? [put.key] : []));
}

export interface FlakyOptions {
  /** The first n puts carrying `ifMatch` answer precondition-failed and write nothing. */
  failIfMatch?: number;
  /** Every put throws this (after nothing was written). */
  putError?: Error;
}

export function flakyStore(base: ObjectStore, options: FlakyOptions): ObjectStore {
  let failures = options.failIfMatch ?? 0;
  return patchStore(
    {
      put: async (key, bytes, opts) => {
        if (options.putError !== undefined) {
          throw options.putError;
        }
        if (opts?.ifMatch !== undefined && failures > 0) {
          failures--;
          return { ok: false, reason: "precondition-failed" };
        }
        return base.put(key, bytes, opts);
      },
    },
    base
  );
}

/**
 * Store ETags that are neither the content SHA-256 nor HTTP entity tags (as on R2): `get`, `head`
 * and `put` report `store:<etag>`, and `ifMatch` is translated back. Shows that a caller passes
 * the store's ETag back and never a digest it computed.
 */
export function opaqueEtagStore(base: ObjectStore = new MemoryStore()): ObjectStore {
  const wrap = (etag: string) => `store:${etag}`;
  return patchStore(
    {
      get: async (key) => {
        const object = await base.get(key);
        return object === null ? null : { ...object, etag: wrap(object.etag) };
      },
      head: async (key) => {
        const object = await base.head(key);
        return object === null ? null : { ...object, etag: wrap(object.etag) };
      },
      put: async (key, bytes, opts = {}) => {
        // A value this wrapper did not hand out (such as a digest) can never match.
        const { ifMatch } = opts;
        const inner =
          ifMatch === undefined || ifMatch.startsWith("store:")
            ? ifMatch?.slice("store:".length)
            : `foreign:${ifMatch}`;
        const result = await base.put(key, bytes, {
          ...opts,
          ...(inner === undefined ? {} : { ifMatch: inner }),
        });
        return result.ok ? { ok: true, etag: wrap(result.etag) } : result;
      },
    },
    base
  );
}
