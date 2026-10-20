// publishCrl on the fs adapter on every run, and on R2 through wrangler's getPlatformProxy with
// AIA_TEST_R2=1 (`pnpm run test:r2`, part of `ci:worker`): the create-only blob and marker and the
// conditional catalog write under each adapter's own precondition semantics and ETags, which
// tests/core/publish.test.ts only sees through MemoryStore.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlatformProxy } from "wrangler";
import { CATALOG_KEY, CatalogSchema, decodeJson } from "../../src/core/catalog.ts";
import type { CurrentCrl } from "../../src/core/catalog.ts";
import { crlHistoryKey } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { FsStore } from "../../src/storage/fs.ts";
import { R2Store } from "../../src/storage/r2.ts";
import type { R2BucketLike } from "../../src/storage/r2.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import { currentCrl } from "../helpers/catalog.ts";
import { publishFile, racingStore, setupPublish } from "../helpers/publish.ts";
import { puts, recordingStore } from "../helpers/store.ts";

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const FULL_03 = "crls/issuing-ca-1/full-03.der";

async function currentOf(store: ObjectStore, targetId: string): Promise<CurrentCrl | null> {
  const object = await store.get(CATALOG_KEY);
  return CatalogSchema.parse(decodeJson(object!.bytes)).targets[targetId]?.current ?? null;
}

async function keys(store: ObjectStore, prefix: string): Promise<string[]> {
  return (await store.list(prefix)).map((object) => object.key);
}

/** The cases of one adapter; `factory` hands each case an empty store. */
function describePublish(name: string, factory: () => ObjectStore | Promise<ObjectStore>): void {
  describe(`publishCrl on ${name}`, () => {
    let store: ObjectStore;
    let targetId: string;

    beforeEach(async () => {
      store = await factory();
      const setup = await setupPublish(store, {
        certificates: ["root-ca", "issuing-ca-1"],
        targets: [{ issuer: "issuing-ca-1", kind: "full" }],
      });
      targetId = setup.target("issuing-ca-1", "full");
    });

    it("created: writes the blob and the current record", async () => {
      const { result } = await publishFile(store, FULL_01);
      const current = await currentCrl(FULL_01, targetId);
      expect(result).toMatchObject({ outcome: "created", targetId, current });
      expect(await currentOf(store, targetId)).toEqual(current);
      expect((await store.get(current.key))!.bytes).toEqual(fixture(FULL_01));
    });

    it("updated: writes the superseded current's marker and replaces current", async () => {
      await publishFile(store, FULL_01);
      const { result } = await publishFile(store, FULL_02);
      const first = await currentCrl(FULL_01, targetId);
      const second = await currentCrl(FULL_02, targetId);
      const marker = crlHistoryKey(targetId, first.summary, first.sha256);
      expect(result).toMatchObject({ outcome: "updated", current: second });
      expect(await currentOf(store, targetId)).toEqual(second);
      expect(await keys(store, `history/${targetId}/`)).toEqual([marker]);
      expect(decodeJson((await store.get(marker))!.bytes)).toEqual({
        ...first,
        supersededAt: NOW.toISOString(),
      });
      expect(await keys(store, `blobs/crls/${targetId}/`)).toEqual([first.key, second.key]);
    });

    it("unchanged: the same CRL again, as PEM, writes nothing", async () => {
      await publishFile(store, FULL_01);
      const recording = recordingStore(store);
      const { result } = await publishFile(recording, "crls/issuing-ca-1/full-01.pem");
      expect(result).toMatchObject({ outcome: "unchanged" });
      expect(recording.writes).toEqual([]);
    });

    // A rival publish lands between this call's state read and its catalog write: the catalog
    // write is lost on the adapter's real precondition, and the retry re-reads.
    it.each([
      ["an older CRL", "updated", FULL_01],
      ["the same CRL", "unchanged", FULL_02],
      ["a newer CRL", "stale_crl", FULL_03],
    ] as const)("race: a rival publishes %s first → %s", async (_, outcome, rivalFile) => {
      const recording = recordingStore(racingStore(store, () => publishFile(store, rivalFile)));
      const run = await publishFile(recording, FULL_02);
      expect(run.sleeps).toEqual([250]);
      expect(puts(recording).find((put) => put.key === CATALOG_KEY)?.ok).toBe(false);
      const ours = await currentCrl(FULL_02, targetId);
      const rival = await currentCrl(rivalFile, targetId);
      expect(await store.head(ours.key)).not.toBeNull();
      if (outcome === "stale_crl") {
        const entry = manifest.crls.find((crl) => crl.file === rivalFile)!;
        expect(run.result).toEqual({
          error: outcome,
          details: {
            current: {
              sha256: entry.sha256,
              crlNumber: entry.crlNumber,
              thisUpdate: new Date(entry.thisUpdate).toISOString(),
            },
          },
        });
        // Our blob is an orphan: not current and without a marker.
        expect(await currentOf(store, targetId)).toEqual(rival);
        expect(await keys(store, "history/")).toEqual([]);
      } else {
        expect(run.result).toMatchObject({ outcome });
        expect(await currentOf(store, targetId)).toEqual(ours);
        expect(await keys(store, "history/")).toEqual(
          outcome === "updated" ? [crlHistoryKey(targetId, rival.summary, rival.sha256)] : []
        );
      }
    });
  });
}

let parent: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "aia-cdp-publish-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describePublish("fs", async () => new FsStore(await mkdtemp(join(parent, "case-"))));

describe.runIf(process.env.AIA_TEST_R2 === "1")("publishCrl via getPlatformProxy", () => {
  let proxy: PlatformProxy<{ STORE: R2BucketLike }> | undefined;
  let store: R2Store;

  beforeAll(async () => {
    // As in r2.test.ts: wrangler only loads here, after its telemetry and banner are off.
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.WRANGLER_HIDE_BANNER = "true";
    const { getPlatformProxy } = await import("wrangler");
    proxy = await getPlatformProxy<{ STORE: R2BucketLike }>({
      configPath: "wrangler.jsonc",
      persist: false,
    });
    store = new R2Store(proxy.env.STORE);
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
  });

  // One proxy is one bucket: every case starts by emptying it.
  beforeEach(async () => {
    for (const object of await store.list("")) {
      await store.delete(object.key);
    }
  });

  describePublish("r2 (getPlatformProxy)", () => store);
});
