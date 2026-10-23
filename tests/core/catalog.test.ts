import { describe, expect, it } from "vitest";
import {
  CATALOG_KEY,
  CatalogSchema,
  CONFIG_KEY,
  ConfigSchema,
  decodeJson,
  emptyCatalog,
  encodeJson,
  InvalidStoredObjectError,
  readState,
  updateCatalog,
  updateState,
} from "../../src/core/catalog.ts";
import type { Catalog, CatalogMutation, State } from "../../src/core/catalog.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { MINIMAL_CONFIG, patchStore, putText } from "../helpers/app.ts";
import { cert, certificateEntry, currentCrl, putCatalog } from "../helpers/catalog.ts";
import { flakyStore, puts, recordingStore, writtenKeys } from "../helpers/store.ts";

// Schemas, canonical format, readState, updateCatalog (slice 2 step 4) and updateState (slice 4). The lost-race case is
// case 3 of worker-aia-cdp@5b570aa:tests/worker/r2-summary.test.ts: a concurrent writer's change
// survives.

const TARGET = "0b6a3a8e-4f5c-4d2a-9c3e-7f1e2d3c4b5a";

function config(overrides: Record<string, unknown> = {}) {
  return { version: 1, certificates: {}, targets: {}, paths: {}, ...overrides };
}

async function catalogWith(...names: string[]): Promise<Catalog> {
  const catalog = emptyCatalog();
  for (const name of names) {
    const { id, entry } = await certificateEntry(name);
    catalog.certificates[id] = entry;
  }
  return catalog;
}

/** A sleep that records its arguments and returns at once. */
function recordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

async function storedCatalog(store: MemoryStore): Promise<Catalog> {
  const object = await store.get(CATALOG_KEY);
  return CatalogSchema.parse(decodeJson(object!.bytes));
}

describe("ConfigSchema", () => {
  const issuer = cert("issuing-ca-1").sha256;

  it("accepts the minimal configuration and a full one", () => {
    expect(ConfigSchema.safeParse(JSON.parse(MINIMAL_CONFIG)).success).toBe(true);
    const full = config({
      certificates: { [issuer]: { label: "Issuing CA 1" } },
      targets: { [TARGET]: { issuer, kind: "full", label: "Issuing CA 1" } },
      paths: { "/ca/issuing-ca-1.crt": { certificate: issuer }, "/crl/a.crl": { target: TARGET } },
    });
    expect(ConfigSchema.parse(full)).toEqual(full);
  });

  it("rejects a misspelled key (strict objects)", () => {
    const result = ConfigSchema.safeParse({ ...config(), tagrets: {} });
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["tagrets"] })
    );
    const label = ConfigSchema.safeParse(
      config({ certificates: { [issuer]: { label: "x", lable: "y" } } })
    );
    expect(label.success).toBe(false);
  });

  it("requires all three maps", () => {
    expect(ConfigSchema.safeParse({ version: 1, certificates: {}, targets: {} }).success).toBe(
      false
    );
  });

  it("rejects uppercase hex certificate ids", () => {
    const upper = issuer.toUpperCase();
    expect(
      ConfigSchema.safeParse(config({ certificates: { [upper]: { label: "x" } } })).success
    ).toBe(false);
    expect(
      ConfigSchema.safeParse(config({ paths: { "/ca/x.crt": { certificate: upper } } })).success
    ).toBe(false);
  });

  it.each([
    ["not RFC 9562 (version 0)", "00000000-0000-0000-0000-000000000001"],
    ["uppercase", TARGET.toUpperCase()],
    ["not a UUID", "issuing-ca-1"],
  ])("rejects a target id that is %s", (_, id) => {
    const target = { issuer, kind: "full", label: "x" };
    expect(ConfigSchema.safeParse(config({ targets: { [id]: target } })).success).toBe(false);
    expect(
      ConfigSchema.safeParse(config({ paths: { "/crl/x.crl": { target: id } } })).success
    ).toBe(false);
  });

  it("rejects a path entry with both or neither reference", () => {
    for (const entry of [{ certificate: issuer, target: TARGET }, {}]) {
      expect(ConfigSchema.safeParse(config({ paths: { "/ca/x.crt": entry } })).success).toBe(false);
    }
  });
});

describe("CatalogSchema", () => {
  it("accepts the empty catalog and imported certificates", async () => {
    expect(CatalogSchema.parse(emptyCatalog())).toEqual(emptyCatalog());
    const catalog = await catalogWith("root-ca", "leaf-min");
    expect(CatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it("accepts a target with a current CRL and a target without one", async () => {
    const catalog = await catalogWith("issuing-ca-1");
    catalog.targets[TARGET] = {
      current: await currentCrl("crls/issuing-ca-1/full-01.der", TARGET),
    };
    catalog.targets[crypto.randomUUID()] = { current: null };
    expect(CatalogSchema.parse(catalog)).toEqual(catalog);
  });

  // Slice 4 step 2: what slices 2–3 wrote by hand no longer fits (pnpm reset:dev, then seed:dev).
  it("rejects a CRL summary without nextPublish or with an unknown revokedCount", async () => {
    const current = await currentCrl("crls/issuing-ca-1/full-01.der", TARGET);
    const { nextPublish: _, ...withoutNextPublish } = current.summary;
    for (const summary of [withoutNextPublish, { ...current.summary, revokedCount: null }]) {
      const value = {
        ...emptyCatalog(),
        targets: { [TARGET]: { current: { ...current, summary } } },
      };
      expect(CatalogSchema.safeParse(value).success).toBe(false);
    }
  });

  it("has no rebind ledger: certificatePaths is an unknown key", () => {
    expect(CatalogSchema.safeParse({ ...emptyCatalog(), certificatePaths: {} }).success).toBe(
      false
    );
  });

  it("rejects uppercase hex in ids and key ids", async () => {
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const ski = entry.summary.subjectKeyId!;
    const cases: unknown[] = [
      { ...emptyCatalog(), certificates: { [id.toUpperCase()]: entry } },
      {
        ...emptyCatalog(),
        certificates: {
          [id]: { ...entry, summary: { ...entry.summary, subjectKeyId: ski.toUpperCase() } },
        },
      },
      {
        ...emptyCatalog(),
        certificates: {
          [id]: { ...entry, summary: { ...entry.summary, sha1: entry.summary.sha1.toUpperCase() } },
        },
      },
    ];
    for (const value of cases) {
      expect(CatalogSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects times that are not Date.toISOString()", async () => {
    const { id, entry } = await certificateEntry("root-ca");
    for (const importedAt of ["2026-01-04T00:00:00Z", "2026-01-04T00:00:00.000+00:00"]) {
      const value = { ...emptyCatalog(), certificates: { [id]: { ...entry, importedAt } } };
      expect(CatalogSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("encodeJson / decodeJson", () => {
  it("writes two-space JSON with a trailing newline", () => {
    const text = new TextDecoder().decode(encodeJson({ version: 1, a: { b: [] } }));
    expect(text).toBe('{\n  "version": 1,\n  "a": {\n    "b": []\n  }\n}\n');
  });

  it("skips a BOM and rejects bytes that are not UTF-8", () => {
    expect(decodeJson(new TextEncoder().encode("﻿{}"))).toEqual({});
    expect(() => decodeJson(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow(TypeError);
  });
});

describe("readState", () => {
  it("reads an empty store as no config and the empty catalog", async () => {
    expect(await readState(new MemoryStore())).toEqual({
      config: null,
      configEtag: null,
      catalog: emptyCatalog(),
      catalogEtag: null,
    });
  });

  it("returns both objects with their store ETags", async () => {
    const store = new MemoryStore();
    await putText(store, CONFIG_KEY, MINIMAL_CONFIG);
    const catalog = await catalogWith("root-ca");
    await putCatalog(store, catalog);
    expect(await readState(store)).toEqual({
      config: JSON.parse(MINIMAL_CONFIG) as unknown,
      configEtag: (await store.get(CONFIG_KEY))!.etag,
      catalog,
      catalogEtag: (await store.get(CATALOG_KEY))!.etag,
    });
  });

  it.each([
    [CONFIG_KEY, "{not json"],
    [CONFIG_KEY, '{"version":1,"certificates":{},"targets":{}}'],
    [CATALOG_KEY, "{not json"],
    [CATALOG_KEY, '{"version":1,"certificates":{},"targets":{},"certificatePaths":{}}'],
  ])("throws on an invalid %s (%s) and never writes", async (key, text) => {
    const base = new MemoryStore();
    await putText(base, CONFIG_KEY, MINIMAL_CONFIG);
    await putText(base, key, text);
    const store = recordingStore(base);
    const error = await readState(store).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidStoredObjectError);
    expect(error).toMatchObject({ key });
    expect(store.writes).toEqual([]);
  });
});

describe("updateCatalog", () => {
  // Adds root-ca unless it is there (the shape importCertificate uses).
  async function addRoot() {
    const { id, entry } = await certificateEntry("root-ca");
    return (catalog: Catalog): CatalogMutation<string> =>
      catalog.certificates[id]
        ? { result: "unchanged" }
        : {
            next: { ...catalog, certificates: { ...catalog.certificates, [id]: entry } },
            result: "created",
          };
  }

  it("creates catalog.json with ifNoneMatch, then replaces it with ifMatch", async () => {
    const base = new MemoryStore();
    const store = recordingStore(base);
    const { sleep, calls } = recordingSleep();
    expect(await updateCatalog(store, await addRoot(), { sleep })).toEqual({ result: "created" });
    const first = await base.get(CATALOG_KEY);

    const issuing = await certificateEntry("issuing-ca-1");
    const addIssuing = (catalog: Catalog): CatalogMutation<string> => ({
      next: { ...catalog, certificates: { ...catalog.certificates, [issuing.id]: issuing.entry } },
      result: "added",
    });
    expect(await updateCatalog(store, addIssuing, { sleep })).toEqual({ result: "added" });

    expect(puts(store)).toEqual([
      { key: CATALOG_KEY, opts: { contentType: "application/json", ifNoneMatch: "*" }, ok: true },
      {
        key: CATALOG_KEY,
        opts: { contentType: "application/json", ifMatch: first!.etag },
        ok: true,
      },
    ]);
    expect(calls).toEqual([]);
    expect(Object.keys((await storedCatalog(base)).certificates)).toEqual([
      cert("root-ca").sha256,
      cert("issuing-ca-1").sha256,
    ]);
  });

  it("writes the canonical format", async () => {
    const base = new MemoryStore();
    await updateCatalog(base, await addRoot(), { sleep: recordingSleep().sleep });
    const stored = await base.get(CATALOG_KEY);
    expect(stored!.bytes).toEqual(encodeJson(await storedCatalog(base)));
  });

  it("re-reads after a lost race and keeps the other writer's change", async () => {
    const base = new MemoryStore();
    await putCatalog(base, emptyCatalog());
    const rival = await certificateEntry("issuing-ca-2");
    let raced = false;
    // The first read returns the old catalog; a rival import lands before our write.
    const store = recordingStore(
      patchStore(
        {
          get: async (key) => {
            const snapshot = await base.get(key);
            if (key === CATALOG_KEY && !raced) {
              raced = true;
              await putCatalog(base, {
                ...emptyCatalog(),
                certificates: { [rival.id]: rival.entry },
              });
            }
            return snapshot;
          },
        },
        base
      )
    );
    const { sleep, calls } = recordingSleep();
    expect(await updateCatalog(store, await addRoot(), { sleep })).toEqual({ result: "created" });
    expect(calls).toEqual([250]);
    expect(puts(store).map((put) => put.ok)).toEqual([false, true]);
    expect(Object.keys((await storedCatalog(base)).certificates).sort()).toEqual(
      [rival.id, cert("root-ca").sha256].sort()
    );
  });

  it("gives up after 1 + 3 attempts with concurrent_update", async () => {
    const base = new MemoryStore();
    await putCatalog(base, emptyCatalog());
    const before = await base.get(CATALOG_KEY);
    const store = recordingStore(flakyStore(base, { failIfMatch: 4 }));
    const { sleep, calls } = recordingSleep();
    expect(await updateCatalog(store, await addRoot(), { sleep })).toEqual({
      error: "concurrent_update",
    });
    expect(calls).toEqual([250, 500, 1000]);
    expect(store.writes).toHaveLength(4);
    expect(writtenKeys(store)).toEqual([]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(before!.bytes);
  });

  it("succeeds on the last attempt", async () => {
    const base = new MemoryStore();
    await putCatalog(base, emptyCatalog());
    const store = recordingStore(flakyStore(base, { failIfMatch: 3 }));
    const { sleep, calls } = recordingSleep();
    expect(await updateCatalog(store, await addRoot(), { sleep })).toEqual({ result: "created" });
    expect(calls).toEqual([250, 500, 1000]);
    expect(writtenKeys(store)).toEqual([CATALOG_KEY]);
  });

  it("does not write when the mutation returns a terminal result", async () => {
    const base = new MemoryStore();
    const add = await addRoot();
    await updateCatalog(base, add, { sleep: recordingSleep().sleep });
    const store = recordingStore(base);
    expect(await updateCatalog(store, add, { sleep: recordingSleep().sleep })).toEqual({
      result: "unchanged",
    });
    expect(store.writes).toEqual([]);
  });

  it("does not retry a put that throws", async () => {
    const failure = new Error("429 too many writes");
    let puts = 0;
    const flaky = flakyStore(new MemoryStore(), { putError: failure });
    const store = patchStore({
      put: (key, bytes, opts) => {
        puts++;
        return flaky.put(key, bytes, opts);
      },
    });
    const { sleep, calls } = recordingSleep();
    await expect(updateCatalog(store, await addRoot(), { sleep })).rejects.toBe(failure);
    expect(puts).toBe(1);
    expect(calls).toEqual([]);
  });

  it("throws instead of writing an invalid catalog", async () => {
    const store = recordingStore();
    const broken = (catalog: Catalog): CatalogMutation<null> => ({
      next: { ...catalog, version: 2 } as unknown as Catalog,
      result: null,
    });
    await expect(updateCatalog(store, broken, { sleep: recordingSleep().sleep })).rejects.toThrow();
    expect(store.writes).toEqual([]);
  });
});

describe("updateState", () => {
  it("gives every attempt a fresh readState and writes on the catalog ETag of that read", async () => {
    const base = new MemoryStore();
    await putText(base, CONFIG_KEY, MINIMAL_CONFIG);
    await putCatalog(base, emptyCatalog());
    const store = recordingStore(flakyStore(base, { failIfMatch: 1 }));
    const { id, entry } = await certificateEntry("root-ca");
    const seen: State[] = [];
    const { sleep, calls } = recordingSleep();
    const result = await updateState(
      store,
      async (state): Promise<CatalogMutation<number>> => {
        seen.push(state);
        await Promise.resolve();
        return {
          next: { ...state.catalog, certificates: { [id]: entry } },
          result: seen.length,
        };
      },
      { sleep }
    );
    expect(result).toEqual({ result: 2 });
    expect(calls).toEqual([250]);
    expect(seen.map((state) => state.config)).toEqual([
      ConfigSchema.parse(JSON.parse(MINIMAL_CONFIG)),
      ConfigSchema.parse(JSON.parse(MINIMAL_CONFIG)),
    ]);
    expect(puts(store).map((put) => [put.key, put.ok, put.opts.ifMatch])).toEqual([
      [CATALOG_KEY, false, seen[0]!.catalogEtag],
      [CATALOG_KEY, true, seen[1]!.catalogEtag],
    ]);
    expect((await readState(base)).catalog.certificates).toEqual({ [id]: entry });
  });
});
