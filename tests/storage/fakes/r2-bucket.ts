// In-memory stand-in for the R2 binding, so the r2 adapter runs the conformance suite on every run.
// Migrated and adapted from worker-aia-cdp@5b570aa:tests/helpers/r2.ts (MemoryBucket):
// - typed against src/storage/r2.ts's R2BucketLike; the Workers globals (R2Object, R2PutOptions,
//   ...) do not exist in the Node program;
// - put compares and writes with no await in between (the old one awaited head() first, so five
//   concurrent writers with the same etagMatches all won);
// - ETags are the unquoted content MD5 like R2's, and a quoted conditional ETag throws TypeError
//   like R2 (worker-aia-cdp spike, 2026-10-18) instead of failing the precondition;
// - list pages are a constructor option, so cursor following is exercised with a few keys.
import { createHash } from "node:crypto";
import type { R2BucketLike, R2ConditionalLike } from "../../../src/storage/r2.ts";

export interface FakeR2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  httpMetadata: { contentType?: string };
}

interface Entry {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
  contentType?: string;
}

function assertUnquoted(etag: string | undefined): void {
  if (etag !== undefined && etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"')) {
    throw new TypeError(
      `Conditional ETag should not be wrapped in quotes (${JSON.stringify(etag.slice(1, -1))}).`
    );
  }
}

/** R2's onlyIf for writes: etagMatches needs an existing object; `*` matches any existing one. */
function preconditionHolds(current: Entry | undefined, onlyIf: R2ConditionalLike = {}): boolean {
  const { etagMatches, etagDoesNotMatch } = onlyIf;
  if (
    etagMatches !== undefined &&
    (!current || (etagMatches !== "*" && etagMatches !== current.etag))
  ) {
    return false;
  }
  if (
    etagDoesNotMatch !== undefined &&
    current &&
    (etagDoesNotMatch === "*" || etagDoesNotMatch === current.etag)
  ) {
    return false;
  }
  return true;
}

export class FakeR2Bucket implements R2BucketLike {
  readonly #entries = new Map<string, Entry>();
  readonly #pageSize: number;
  #listCalls = 0;

  constructor(options: { pageSize?: number } = {}) {
    this.#pageSize = options.pageSize ?? 1000;
  }

  /** Number of list() pages served so far. */
  get listCalls(): number {
    return this.#listCalls;
  }

  #object(key: string, entry: Entry): FakeR2Object {
    return {
      key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      httpEtag: `"${entry.etag}"`,
      httpMetadata: entry.contentType === undefined ? {} : { contentType: entry.contentType },
    };
  }

  async get(key: string): Promise<(FakeR2Object & { arrayBuffer(): Promise<ArrayBuffer> }) | null> {
    const entry = this.#entries.get(key);
    if (!entry) {
      return null;
    }
    const bytes = entry.bytes.slice();
    return { ...this.#object(key, entry), arrayBuffer: async () => bytes.buffer };
  }

  async put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata?: { contentType: string }; onlyIf?: R2ConditionalLike } = {}
  ): Promise<FakeR2Object | null> {
    assertUnquoted(options.onlyIf?.etagMatches);
    assertUnquoted(options.onlyIf?.etagDoesNotMatch);
    // Synchronous from here to the write: of several racing conditional puts only one sees the
    // old ETag.
    const bytes = value.slice();
    if (!preconditionHolds(this.#entries.get(key), options.onlyIf)) {
      return null;
    }
    const entry: Entry = {
      bytes,
      etag: createHash("md5").update(bytes).digest("hex"),
      contentType: options.httpMetadata?.contentType,
    };
    this.#entries.set(key, entry);
    return this.#object(key, entry);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    objects: FakeR2Object[];
    truncated: boolean;
    cursor?: string;
  }> {
    this.#listCalls += 1;
    // The cursor is the last key served: later pages start after it even if keys change.
    const after = options.cursor;
    const keys = [...this.#entries.keys()]
      .filter((key) => key.startsWith(options.prefix) && (after === undefined || key > after))
      .sort();
    const page = keys.slice(0, this.#pageSize);
    const objects = page.map((key) => this.#object(key, this.#entries.get(key)!));
    return keys.length > page.length
      ? { objects, truncated: true, cursor: page.at(-1) }
      : { objects, truncated: false };
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}
