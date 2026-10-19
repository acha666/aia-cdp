// Filesystem ObjectStore adapter for the Node runtime (plan §5.4). One data directory belongs to one
// process (plan §1): conditional writes are serialized by an in-process per-key mutex.
//
// Layout: key `a/b/c` is the file `<root>/a/b/c`. assertStoreKey is the path traversal guard (no
// empty, `.`/`..` or dot-leading segment, no `\` or NUL), so every path stays below the root and
// no key can name a temporary file. A key cannot also be the directory of other keys here; the
// keys of plan §5.1 never are.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { sha256Hex } from "../core/digest.ts";
import { assertStoreKey, assertStorePrefix } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

// Keyed by absolute file path, so two FsStore instances on one directory share the lock.
const locks = new Map<string, Promise<void>>();

async function exclusive<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(path);
  const { promise, resolve: release } = Promise.withResolvers<void>();
  locks.set(path, promise);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (locks.get(path) === promise) {
      locks.delete(path);
    }
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** The key does not name a file: it is missing, below a file, or a directory of other keys. */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "ERR_FS_EISDIR";
}

async function fsyncDirectory(path: string): Promise<void> {
  // Windows cannot open a directory for fsync; rename is the best it offers.
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** ETag = content SHA-256 (lowercase hex). The root must exist; it is never created. */
export class FsStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    return join(this.#root, ...key.split("/"));
  }

  async #read(path: string): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(path);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isAbsent(error)) {
        return null;
      }
      throw error;
    }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    assertStoreKey(key);
    const bytes = await this.#read(this.#path(key));
    return bytes ? { bytes, etag: await sha256Hex(bytes) } : null;
  }

  async head(key: string): Promise<{ etag: string; size: number } | null> {
    assertStoreKey(key);
    // The ETag is the content digest, so head reads the file too.
    const bytes = await this.#read(this.#path(key));
    return bytes ? { etag: await sha256Hex(bytes), size: bytes.byteLength } : null;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    assertStoreKey(key);
    // Copy before the first await so later changes to the caller's buffer cannot leak in.
    const copy = bytes.slice();
    const etag = await sha256Hex(copy);
    const segments = key.split("/");
    const path = this.#path(key);
    return exclusive(path, async (): Promise<PutResult> => {
      if (opts.ifMatch !== undefined || opts.ifNoneMatch === "*") {
        const current = await this.#read(path);
        const currentEtag = current ? await sha256Hex(current) : undefined;
        if (opts.ifNoneMatch === "*" && currentEtag !== undefined) {
          return { ok: false, reason: "precondition-failed" };
        }
        if (opts.ifMatch !== undefined && currentEtag !== opts.ifMatch) {
          return { ok: false, reason: "precondition-failed" };
        }
      }

      // mkdir -p of the key's parent, but only below the root (a missing root fails with ENOENT).
      // Remember which directories gained an entry so their new entries get fsynced too.
      const changed: string[] = [];
      let dir = this.#root;
      for (const segment of segments.slice(0, -1)) {
        const child = join(dir, segment);
        try {
          await mkdir(child);
          changed.push(dir);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw error;
          }
        }
        dir = child;
      }

      // The dot-leading name keeps the temporary file out of list() and out of the key space.
      const temp = join(dirname(path), `.${segments.at(-1) ?? ""}.${randomUUID()}.tmp`);
      const handle = await open(temp, "wx");
      try {
        try {
          await handle.writeFile(copy);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      for (const directory of new Set([dir, ...changed])) {
        await fsyncDirectory(directory);
      }
      return { ok: true, etag };
    });
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    // A valid prefix is whole segments plus `/`, so its keys all live below one directory.
    const base = prefix === "" ? this.#root : this.#path(prefix.slice(0, -1));
    let entries: string[];
    try {
      entries = await readdir(base, { recursive: true });
    } catch (error) {
      if (isAbsent(error)) {
        return [];
      }
      throw error;
    }
    const objects = await Promise.all(
      entries.map(async (entry) => {
        const segments = entry.split(sep);
        // Temporary files (and anything else dot-leading) are not keys.
        if (segments.some((segment) => segment.startsWith("."))) {
          return null;
        }
        try {
          const info = await stat(join(base, entry));
          return info.isFile() ? { key: prefix + segments.join("/"), size: info.size } : null;
        } catch (error) {
          // Deleted between readdir and stat.
          if (errorCode(error) === "ENOENT") {
            return null;
          }
          throw error;
        }
      })
    );
    return objects.filter((object) => object !== null).sort(byKey);
  }

  async delete(key: string): Promise<void> {
    assertStoreKey(key);
    const path = this.#path(key);
    await exclusive(path, async () => {
      try {
        await rm(path, { force: true });
      } catch (error) {
        // Not a file (below a file, or a directory of other keys): there is nothing to delete.
        if (!isAbsent(error)) {
          throw error;
        }
      }
    });
  }
}
