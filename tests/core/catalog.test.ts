import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_KEY,
  CatalogSchema,
  CONFIG_KEY,
  ConfigSchema,
  decodeJson,
  emptyCatalog,
  emptyConfig,
  encodeJson,
  InvalidStoredObjectError,
  readCatalog,
  readState,
  updateState,
} from "../../src/core/catalog.ts";
import type { Catalog, CatalogMutation, State } from "../../src/core/catalog.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { MINIMAL_CONFIG, patchStore, putText } from "../helpers/app.ts";
import { certificateEntry, currentCrl, putCatalog } from "../helpers/catalog.ts";
import { flakyStore, puts, recordingStore } from "../helpers/store.ts";

// Schemas, canonical format, readState, and the conditional catalog write, which keeps a
// concurrent writer's change.

const TARGET = "0b6a3a8e-4f5c-4d2a-9c3e-7f1e2d3c4b5a";
const ROOT = await certificateEntry("root-ca");
const ISSUING = await certificateEntry("issuing-ca-1");
const ISSUER = ISSUING.id;
const CURRENT = await currentCrl("crls/issuing-ca-1/full-01.der", TARGET);

function config(overrides: Record<string, unknown> = {}) {
  return { ...emptyConfig(), ...overrides };
}

function catalog(certificates: Catalog["certificates"], targets: Catalog["targets"] = {}) {
  return { ...emptyCatalog(), certificates, targets };
}

async function certificateIds(store: MemoryStore): Promise<string[]> {
  return Object.keys((await readCatalog(store)).catalog.certificates);
}

// Adds root-ca unless it is there (the shape importCertificate uses).
function addRoot({ catalog: current }: State): CatalogMutation<string> {
  return current.certificates[ROOT.id]
    ? { result: "unchanged" }
    : {
        next: { ...current, certificates: { ...current.certificates, [ROOT.id]: ROOT.entry } },
        result: "created",
      };
}

describe("ConfigSchema", () => {
  it("accepts the minimal configuration and a full one", () => {
    expect(ConfigSchema.safeParse(JSON.parse(MINIMAL_CONFIG)).success).toBe(true);
    const full = config({
      certificates: { [ISSUER]: { label: "Issuing CA 1" } },
      targets: { [TARGET]: { issuer: ISSUER, kind: "full", label: "Issuing CA 1" } },
      paths: { "/ca/issuing-ca-1.crt": { certificate: ISSUER }, "/crl/a.crl": { target: TARGET } },
    });
    expect(ConfigSchema.parse(full)).toEqual(full);
  });

  const target = { issuer: ISSUER, kind: "full", label: "x" };
  it.each<[string, unknown]>([
    ["a misspelled key", { ...config(), tagrets: {} }],
    ["a missing map", { version: 1, certificates: {}, targets: {} }],
    [
      "an uppercase hex certificate id",
      config({ certificates: { [ISSUER.toUpperCase()]: { label: "x" } } }),
    ],
    [
      "a target id that is not RFC 9562",
      config({ targets: { "00000000-0000-0000-0000-000000000001": target } }),
    ],
    ["an uppercase target id", config({ targets: { [TARGET.toUpperCase()]: target } })],
    [
      "a path entry with both references",
      config({ paths: { "/ca/x.crt": { certificate: ISSUER, target: TARGET } } }),
    ],
  ])("rejects %s", (_, value) => {
    expect(ConfigSchema.safeParse(value).success).toBe(false);
  });
});

describe("CatalogSchema", () => {
  it("accepts imported certificates and targets with and without a current CRL", () => {
    expect(CatalogSchema.parse(emptyCatalog())).toEqual(emptyCatalog());
    const value = catalog(
      { [ISSUING.id]: ISSUING.entry },
      { [TARGET]: { current: CURRENT }, [crypto.randomUUID()]: { current: null } }
    );
    expect(CatalogSchema.parse(value)).toEqual(value);
  });

  const { entry } = ISSUING;
  const uncounted = { ...CURRENT, summary: { ...CURRENT.summary, revokedCount: null } };
  it.each<[string, unknown]>([
    ["an unknown key", { ...emptyCatalog(), note: "x" }],
    ["an uppercase hex certificate id", catalog({ [ISSUING.id.toUpperCase()]: entry })],
    [
      "a time that is not Date.toISOString()",
      catalog({ [ISSUING.id]: { ...entry, importedAt: "2026-01-04T00:00:00Z" } }),
    ],
    [
      "a published CRL without its revokedCount",
      { ...emptyCatalog(), targets: { [TARGET]: { current: uncounted } } },
    ],
  ])("rejects %s", (_, value) => {
    expect(CatalogSchema.safeParse(value).success).toBe(false);
  });
});

describe("encodeJson / decodeJson", () => {
  it("writes two-space JSON with a trailing newline", () => {
    const text = new TextDecoder().decode(encodeJson({ version: 1, a: { b: [] } }));
    expect(text).toBe('{\n  "version": 1,\n  "a": {\n    "b": []\n  }\n}\n');
  });

  it("skips a BOM and rejects bytes that are not UTF-8", () => {
    expect(decodeJson(new TextEncoder().encode("\uFEFF{}"))).toEqual({});
    expect(() => decodeJson(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow(TypeError);
  });
});

describe("readState", () => {
  it("reads an empty store as the empty config, not stored, and the empty catalog", async () => {
    expect(await readState(new MemoryStore())).toEqual({
      config: emptyConfig(),
      hasConfig: false,
      catalog: emptyCatalog(),
      catalogEtag: null,
    });
  });

  it("returns both objects and the catalog's store ETag", async () => {
    const store = new MemoryStore();
    await putText(store, CONFIG_KEY, MINIMAL_CONFIG);
    const value = catalog({ [ROOT.id]: ROOT.entry });
    await putCatalog(store, value);
    expect(await readState(store)).toEqual({
      config: JSON.parse(MINIMAL_CONFIG) as unknown,
      hasConfig: true,
      catalog: value,
      catalogEtag: (await store.get(CATALOG_KEY))!.etag,
    });
  });

  it.each([
    [CONFIG_KEY, "{not json"],
    [CATALOG_KEY, '{"version":1,"certificates":{},"targets":{},"note":"x"}'],
  ])("throws on an invalid %s (%s)", async (key, text) => {
    const store = new MemoryStore();
    await putText(store, CONFIG_KEY, MINIMAL_CONFIG);
    await putText(store, key, text);
    const error = await readState(store).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidStoredObjectError);
    expect(error).toMatchObject({ key });
  });
});

describe("updateState", () => {
  it("creates catalog.json with ifNoneMatch, then replaces it with ifMatch", async () => {
    const base = new MemoryStore();
    const store = recordingStore(base);
    const sleep = vi.fn(() => Promise.resolve());
    expect(await updateState(store, addRoot, sleep)).toEqual({ result: "created" });
    const first = await base.get(CATALOG_KEY);
    expect(first!.bytes).toEqual(encodeJson((await readCatalog(base)).catalog));

    const addIssuing = ({ catalog: current }: State): CatalogMutation<string> => ({
      next: { ...current, certificates: { ...current.certificates, [ISSUING.id]: ISSUING.entry } },
      result: "added",
    });
    expect(await updateState(store, addIssuing, sleep)).toEqual({ result: "added" });

    expect(puts(store)).toEqual([
      { key: CATALOG_KEY, opts: { contentType: "application/json", ifNoneMatch: "*" }, ok: true },
      {
        key: CATALOG_KEY,
        opts: { contentType: "application/json", ifMatch: first!.etag },
        ok: true,
      },
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(await certificateIds(base)).toEqual([ROOT.id, ISSUING.id]);
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
              await putCatalog(base, catalog({ [rival.id]: rival.entry }));
            }
            return snapshot;
          },
        },
        base
      )
    );
    const sleep = vi.fn(() => Promise.resolve());
    expect(await updateState(store, addRoot, sleep)).toEqual({ result: "created" });
    expect(sleep.mock.calls).toEqual([[250]]);
    expect(puts(store).map((put) => put.ok)).toEqual([false, true]);
    expect((await certificateIds(base)).sort()).toEqual([rival.id, ROOT.id].sort());
  });

  it("gives up after 1 + 3 attempts with concurrent_update", async () => {
    const base = new MemoryStore();
    await putCatalog(base, emptyCatalog());
    const before = await base.get(CATALOG_KEY);
    const store = recordingStore(flakyStore(base, { failIfMatch: 4 }));
    const sleep = vi.fn(() => Promise.resolve());
    expect(await updateState(store, addRoot, sleep)).toEqual({ error: "concurrent_update" });
    expect(sleep.mock.calls).toEqual([[250], [500], [1000]]);
    expect(store.writes).toHaveLength(4);
    expect(puts(store).filter((put) => put.ok)).toEqual([]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(before!.bytes);
  });

  it("does not retry a put that throws", async () => {
    const failure = new Error("429 too many writes");
    const store = flakyStore(new MemoryStore(), { putError: failure });
    const sleep = vi.fn(() => Promise.resolve());
    await expect(updateState(store, addRoot, sleep)).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives every attempt a fresh readState and writes on the catalog ETag of that read", async () => {
    const base = new MemoryStore();
    await putText(base, CONFIG_KEY, MINIMAL_CONFIG);
    await putCatalog(base, emptyCatalog());
    const store = recordingStore(flakyStore(base, { failIfMatch: 1 }));
    const seen: State[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const result = await updateState(
      store,
      async (state): Promise<CatalogMutation<number>> => {
        seen.push(state);
        await Promise.resolve();
        return { next: catalog({ [ROOT.id]: ROOT.entry }), result: seen.length };
      },
      sleep
    );
    expect(result).toEqual({ result: 2 });
    expect(sleep.mock.calls).toEqual([[250]]);
    const minimal = JSON.parse(MINIMAL_CONFIG) as unknown;
    expect(seen.map((state) => state.config)).toEqual([minimal, minimal]);
    expect(puts(store).map((put) => [put.key, put.ok, put.opts.ifMatch])).toEqual([
      [CATALOG_KEY, false, seen[0]!.catalogEtag],
      [CATALOG_KEY, true, seen[1]!.catalogEtag],
    ]);
    expect(await certificateIds(base)).toEqual([ROOT.id]);
  });
});
