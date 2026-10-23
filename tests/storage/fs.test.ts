import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FsStore } from "../../src/storage/fs.ts";
import { describeObjectStore } from "./conformance.ts";

// rename stays the real one unless a case swaps in its own implementation (to pause or fail a put
// between writing its temporary file and renaming it into place).
vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const isRoot = process.getuid?.() === 0;

let parent: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "aia-cdp-fs-store-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

/** A new, empty, existing directory per call. */
function freshDir(): Promise<string> {
  return mkdtemp(join(parent, "case-"));
}

const bytes = (text: string) => new TextEncoder().encode(text);

describeObjectStore("fs", async () => new FsStore(await freshDir()));

describe("FsStore", () => {
  it("stores key a/b/c as the file <root>/a/b/c and reads it back from a new instance", async () => {
    const root = await freshDir();
    const first = new FsStore(root);
    const created = await first.put("blobs/crls/t1/x.der", bytes("crl"), { ifNoneMatch: "*" });
    if (!created.ok) {
      throw new Error("put failed");
    }
    expect(
      new TextDecoder().decode(await readFile(join(root, "blobs", "crls", "t1", "x.der")))
    ).toBe("crl");

    const second = new FsStore(root);
    const got = await second.get("blobs/crls/t1/x.der");
    expect(got?.etag).toBe(created.etag);
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes("crl")));
    expect(await second.list("")).toEqual([{ key: "blobs/crls/t1/x.der", size: 3 }]);
    // The ETag (content SHA-256) survives the restart, so CAS continues where it left off.
    expect(
      (await second.put("blobs/crls/t1/x.der", bytes("crl2"), { ifMatch: created.etag })).ok
    ).toBe(true);
  });

  it("serializes conditional puts across instances on the same directory", async () => {
    const root = await freshDir();
    const stores = [new FsStore(root), new FsStore(root)];
    const created = await stores[0]!.put("catalog.json", bytes("base"));
    if (!created.ok) {
      throw new Error("put failed");
    }
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        stores[index % 2]!.put("catalog.json", bytes(`w${index}`), { ifMatch: created.etag })
      )
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("does not list dot-leading files or directories (temporary files)", async () => {
    const root = await freshDir();
    await writeFile(join(root, ".x.tmp"), "junk");
    await mkdir(join(root, "blobs", ".hidden"), { recursive: true });
    await writeFile(join(root, "blobs", `.a.der.${crypto.randomUUID()}.tmp`), "junk");
    await writeFile(join(root, "blobs", ".hidden", "b.der"), "junk");
    const store = new FsStore(root);
    expect(await store.list("")).toEqual([]);

    expect((await store.put("blobs/a.der", bytes("a"))).ok).toBe(true);
    expect(await store.list("")).toEqual([{ key: "blobs/a.der", size: 1 }]);
    expect(await store.list("blobs/")).toEqual([{ key: "blobs/a.der", size: 1 }]);
  });

  it("lists only names that are store keys and never walks into other directories", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    expect((await store.put("blobs/a.der", bytes("a"))).ok).toBe(true);
    // Left behind by an operator or an editor; get() / delete() would reject these as keys.
    await writeFile(join(root, "blobs", "a (copy).der"), "junk");
    await writeFile(join(root, "blobs", "x.der~"), "junk");
    await mkdir(join(root, "blobs", "old copy"));
    await writeFile(join(root, "blobs", "old copy", "b.der"), "junk");
    await mkdir(join(root, "lost+found"));
    await writeFile(join(root, "lost+found", "c.der"), "junk");

    expect(await store.list("")).toEqual([{ key: "blobs/a.der", size: 1 }]);
    expect(await store.list("blobs/")).toEqual([{ key: "blobs/a.der", size: 1 }]);
    // Whatever list() returns can be deleted (test cleanup and later GC loops rely on it).
    for (const object of await store.list("")) {
      await store.delete(object.key);
    }
    expect(await store.list("")).toEqual([]);
    expect((await readdir(join(root, "blobs"))).sort()).toEqual([
      "a (copy).der",
      "old copy",
      "x.der~",
    ]);
  });

  it("does not list the temporary file of a put in progress", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    const realRename = vi.mocked(rename).getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    const paused = Promise.withResolvers<string>();
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      paused.resolve(String(from));
      await gate.promise;
      return realRename(from, to);
    });

    const put = store.put("blobs/certificates/a.der", bytes("abc"));
    const temp = await paused.promise;
    // The temporary file is written and synced next to its target, under a dot-leading name.
    expect(dirname(temp)).toBe(join(root, "blobs", "certificates"));
    expect(basename(temp)).toMatch(/^\.a\.der\.[0-9a-f-]{36}\.tmp$/);
    expect(await readdir(dirname(temp))).toEqual([basename(temp)]);
    expect(await store.list("")).toEqual([]);
    expect(await store.list("blobs/certificates/")).toEqual([]);
    expect(await store.get("blobs/certificates/a.der")).toBeNull();

    gate.resolve();
    expect((await put).ok).toBe(true);
    expect(await store.list("")).toEqual([{ key: "blobs/certificates/a.der", size: 3 }]);
    expect(await readdir(dirname(temp))).toEqual(["a.der"]);
  });

  it("removes the temporary file when a step fails and keeps the old content", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    expect((await store.put("config.json", bytes("old"))).ok).toBe(true);
    const failure = Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    vi.mocked(rename).mockRejectedValueOnce(failure);

    await expect(store.put("config.json", bytes("new"))).rejects.toBe(failure);
    expect(await readdir(root)).toEqual(["config.json"]);
    expect(new TextDecoder().decode((await store.get("config.json"))!.bytes)).toBe("old");
  });

  it("treats a missing root as empty", async () => {
    const store = new FsStore(join(await freshDir(), "missing"));
    expect(await store.list("")).toEqual([]);
    expect(await store.list("blobs/")).toEqual([]);
    expect(await store.get("config.json")).toBeNull();
    await expect(store.delete("config.json")).resolves.toBeUndefined();
  });

  it("treats a directory, or a path below a file, as a missing key", async () => {
    const store = new FsStore(await freshDir());
    expect((await store.put("blobs/a.der", bytes("a"))).ok).toBe(true);
    for (const key of ["blobs", "blobs/a.der/x"]) {
      expect(await store.get(key)).toBeNull();
      await expect(store.delete(key)).resolves.toBeUndefined();
    }
    expect(await store.list("blobs/a.der/")).toEqual([]);
    expect(await store.list("")).toEqual([{ key: "blobs/a.der", size: 1 }]);
  });

  it("rejects path traversal before touching the disk", async () => {
    const outer = await freshDir();
    const root = join(outer, "root");
    await mkdir(root);
    const store = new FsStore(root);
    await expect(store.put("../escape", bytes("x"))).rejects.toThrow(TypeError);
    await expect(store.put("a/../../escape", bytes("x"))).rejects.toThrow(TypeError);
    expect(await readdir(outer, { recursive: true })).toEqual(["root"]);
  });

  it.skipIf(isRoot)("throws on an unreadable root instead of reporting a missing key", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    expect((await store.put("config.json", bytes("{}"))).ok).toBe(true);
    await chmod(root, 0o000);
    try {
      await expect(store.get("config.json")).rejects.toMatchObject({ code: "EACCES" });
      await expect(store.list("")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(root, 0o700);
    }
  });
});
