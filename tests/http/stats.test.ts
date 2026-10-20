// GET /api/v1/stats (implementation slice 5a steps 5 and 7; §10 #16): counts and bytes by resource,
// from config.json and catalog.json alone. Migrated: worker-aia-cdp@5b570aa:tests/worker/
// api-stats.test.ts, which counted logical resources but summed every stored object (archives,
// aliases, PEM companions); now neither history nor any other stored object is counted, and the
// store is never listed.
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, CONFIG_KEY } from "../../src/core/catalog.ts";
import { Stats } from "../../src/http/schemas.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { patchStore } from "../helpers/app.ts";
import { cert, crlEntry } from "../helpers/catalog.ts";
import { DEFAULT_TARGETS, IMPORTED } from "../helpers/publish.ts";
import { expectHead, okJson, readService, recordReads } from "../helpers/reads.ts";
import type { ReadServiceOptions } from "../helpers/reads.ts";

const STATS = "/api/v1/stats";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

async function statsOf(options: ReadServiceOptions = {}) {
  const service = await readService(options);
  const body = await okJson(await service.app.request(STATS));
  expect(Stats.parse(body)).toEqual(body);
  return Stats.parse(body);
}

/** The DER sizes of the fixture files. */
function bytes(...files: string[]): number {
  return files.reduce((sum, file) => sum + fixture(file).byteLength, 0);
}

const CERTIFICATE_BYTES = bytes(...IMPORTED.map((name) => cert(name).der));

const KINDS = {
  full: DEFAULT_TARGETS.filter((spec) => spec.kind === "full").length,
  delta: DEFAULT_TARGETS.filter((spec) => spec.kind === "delta").length,
};

describe("GET /api/v1/stats", () => {
  it("counts certificates, targets and published CRLs; derBytes is the fixture files' size", async () => {
    const published = [FULL_02, DELTA_01, ROOT_FULL_01];
    expect(await statsOf({ publish: published })).toEqual({
      certificates: IMPORTED.length,
      targets: KINDS,
      published: { full: 2, delta: 1 },
      totalRevocations: crlEntry(FULL_02).revoked + crlEntry(ROOT_FULL_01).revoked,
      derBytes: CERTIFICATE_BYTES + bytes(...published),
    });
  });

  it("counts the current CRL of a target only, not the version it superseded", async () => {
    const stats = await statsOf({ publish: [FULL_01, FULL_02] });
    expect(stats.published).toEqual({ full: 1, delta: 0 });
    expect(stats.derBytes).toBe(CERTIFICATE_BYTES + bytes(FULL_02));
  });

  it("sums full CRLs only: null without a published full, 0 for a full without entries", async () => {
    expect(crlEntry(DELTA_01).revoked).toBeGreaterThan(0);
    expect((await statsOf({ publish: [DELTA_01] })).totalRevocations).toBeNull();
    expect((await statsOf()).totalRevocations).toBeNull();
    expect(crlEntry(ROOT_FULL_01).revoked).toBe(0);
    expect((await statsOf({ publish: [ROOT_FULL_01, DELTA_01] })).totalRevocations).toBe(0);
    expect((await statsOf({ publish: [FULL_01, DELTA_01] })).totalRevocations).toBe(
      crlEntry(FULL_01).revoked
    );
  });

  it("counts the catalog's certificates only without config.json", async () => {
    const service = await readService({ publish: [FULL_01] });
    await service.base.delete(CONFIG_KEY);
    expect(await okJson(await service.app.request(STATS))).toEqual({
      certificates: IMPORTED.length,
      targets: { full: 0, delta: 0 },
      published: { full: 0, delta: 0 },
      totalRevocations: null,
      derBytes: CERTIFICATE_BYTES,
    });
  });

  it("reads config.json and catalog.json once each and never lists the store", async () => {
    const service = await readService({ publish: [FULL_01], wrap: recordReads });
    const store = service.deps.store as ReturnType<typeof recordReads>;
    await okJson(await service.app.request(STATS));
    expect(store.gets.sort()).toEqual([CATALOG_KEY, CONFIG_KEY].sort());
    expect(store.lists).toEqual([]);
  });

  it("answers without the store's list at all", async () => {
    const stats = await statsOf({
      publish: [FULL_01],
      wrap: (base) => patchStore({ list: () => Promise.reject(new Error("list called")) }, base),
    });
    expect(stats.published.full).toBe(1);
  });

  it("has no time-dependent field: the same body under any clock", async () => {
    const at = (now: Date) =>
      readService({ publish: [FULL_01], overrides: { now: () => now } }).then(async (service) =>
        okJson(await service.app.request(STATS))
      );
    const later = new Date(NOW.getTime() + 20 * 365 * 24 * 3600 * 1000);
    const body = await at(NOW);
    expect(await at(later)).toEqual(body);
    expect(Object.keys(body as object).sort()).toEqual(
      ["certificates", "derBytes", "published", "targets", "totalRevocations"].sort()
    );
  });

  it("answers HEAD with the headers and no body", async () => {
    const service = await readService();
    await expectHead(await service.app.request(STATS, { method: "HEAD" }));
  });
});
