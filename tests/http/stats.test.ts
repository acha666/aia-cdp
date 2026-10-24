// GET /api/v1/stats: counts and bytes by resource, from config.json and catalog.json alone; neither
// history nor any other stored object is counted.
import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../../src/core/catalog.ts";
import { Stats } from "../../src/http/schemas.ts";
import { cert, crlEntry, fixture } from "../fixtures/pki.ts";
import { DEFAULT_TARGETS, IMPORTED } from "../helpers/publish.ts";
import { okJson, readService } from "../helpers/reads.ts";

const STATS = "/api/v1/stats";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

async function statsOf(publish: string[] = []) {
  const service = await readService({ publish });
  return okJson(await service.app.request(STATS), Stats);
}

/** The DER sizes of the fixture files. */
function bytes(...files: string[]): number {
  return files.reduce((sum, file) => sum + fixture(file).byteLength, 0);
}

const CERTIFICATE_BYTES = bytes(...IMPORTED.map((name) => cert(name).der));

describe("GET /api/v1/stats", () => {
  it("counts certificates, targets and published CRLs; derBytes is the fixture files' size", async () => {
    const published = [FULL_02, DELTA_01, ROOT_FULL_01];
    expect(await statsOf(published)).toEqual({
      certificates: IMPORTED.length,
      targets: {
        full: DEFAULT_TARGETS.filter((spec) => spec.kind === "full").length,
        delta: DEFAULT_TARGETS.filter((spec) => spec.kind === "delta").length,
      },
      published: { full: 2, delta: 1 },
      totalRevocations: crlEntry(FULL_02).revoked + crlEntry(ROOT_FULL_01).revoked,
      derBytes: CERTIFICATE_BYTES + bytes(...published),
    });
  });

  it("counts the current CRL of a target only, not the version it superseded", async () => {
    const stats = await statsOf([FULL_01, FULL_02]);
    expect(stats.published).toEqual({ full: 1, delta: 0 });
    expect(stats.derBytes).toBe(CERTIFICATE_BYTES + bytes(FULL_02));
  });

  it("sums full CRLs only: null without a published full, 0 for a full without entries", async () => {
    expect(crlEntry(DELTA_01).revoked).toBeGreaterThan(0);
    expect((await statsOf([DELTA_01])).totalRevocations).toBeNull();
    expect(crlEntry(ROOT_FULL_01).revoked).toBe(0);
    expect((await statsOf([ROOT_FULL_01, DELTA_01])).totalRevocations).toBe(0);
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
});
