// Filesystem ObjectStore adapter for the Node runtime (plan §5.4). One data directory belongs to one
// process (plan §1): conditional writes are serialized by an in-process per-key mutex.
//
// Layout: key `a/b/c` is the file `<root>/a/b/c`. assertStoreKey is the path traversal guard (no
// empty, `.`/`..` or dot-leading segment, no `\` or NUL), so every path stays below the root and
// no key can name a temporary file. A key cannot also be the directory of other keys here; the
// keys of plan §5.1 never are. Anything else in the directory (an operator's `a (copy).der`, an
// editor's `x.der~`, `lost+found` at the root of a volume) is not a key: list() skips it.
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { sha256Hex } from "../core/digest.ts";
import { assertStoreKey, assertStorePrefix, isStoreKeySegment } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

/** `.<key segment>.<uuid>.tmp`: the temporary file of a put, next to its target. */
const TEMP_FILE =
  /^\.[A-Za-z0-9_-][A-Za-z0-9._-]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

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

interface WalkEntry {
  /** Path below the walked directory, one element per name. */
  segments: string[];
  path: string;
  dirent: Dirent;
}

/**
 * Every entry that is not a directory, in `dir` and in the directories below it whose names are
 * key segments. Other directories (dot-leading, `lost+found`, `old copy`) are never opened, so an
 * unreadable one cannot fail the walk. A missing `dir` (or one removed while walking) is empty.
 */
async function walk(dir: string, segments: string[] = []): Promise<WalkEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    dirents.map(async (dirent): Promise<WalkEntry[]> => {
      const entry = { segments: [...segments, dirent.name], path: join(dir, dirent.name), dirent };
      if (!dirent.isDirectory()) {
        return [entry];
      }
      return isStoreKeySegment(dirent.name) ? walk(entry.path, entry.segments) : [];
    })
  );
  return nested.flat();
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
      const directories = [this.#root];
      let dir = this.#root;
      for (const segment of segments.slice(0, -1)) {
        dir = join(dir, segment);
        directories.push(dir);
        try {
          await mkdir(dir);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw error;
          }
        }
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
      // The new entry, and every directory entry on the way to it, must be durable before ok:
      // fsync each directory from the key's parent up to the root, also those this put did not
      // create (another put may have created one and not synced it yet, or failed before it did).
      for (const directory of directories.reverse()) {
        await fsyncDirectory(directory);
      }
      return { ok: true, etag };
    });
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    // A valid prefix is whole segments plus `/`, so its keys all live below one directory.
    const base = prefix === "" ? this.#root : this.#path(prefix.slice(0, -1));
    const objects = await Promise.all(
      (await walk(base)).map(async ({ segments, path, dirent }) => {
        // Only names that are key segments: not temporary files (dot-leading) or stray files.
        if (!isStoreKeySegment(dirent.name)) {
          return null;
        }
        try {
          // stat, not the dirent: a symbolic link to a file counts, as for get().
          const info = await stat(path);
          return info.isFile() ? { key: prefix + segments.join("/"), size: info.size } : null;
        } catch (error) {
          // Deleted between readdir and stat (or a dangling link).
          if (errorCode(error) === "ENOENT") {
            return null;
          }
          throw error;
        }
      })
    );
    return objects.filter((object) => object !== null).sort(byKey);
  }

  /**
   * Removes the temporary files (`.<name>.<uuid>.tmp`) that puts killed mid-write (SIGKILL, OOM,
   * power loss) left in the key directories, and returns how many it removed. Only while no put
   * can run: the Node entry calls it once at startup, before serving (one process per directory,
   * plan §1); a put in progress would lose its temporary file.
   */
  async removeTemporaryFiles(): Promise<number> {
    const stale = (await walk(this.#root)).filter(
      ({ dirent }) => dirent.isFile() && TEMP_FILE.test(dirent.name)
    );
    await Promise.all(stale.map(({ path }) => rm(path, { force: true })));
    return stale.length;
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
