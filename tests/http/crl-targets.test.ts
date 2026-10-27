// GET /api/v1/crls, on state built through importCertificate / applyConfig / publishCrl: published
// and unpublished targets (`current: null`) and their issuer.
import { describe, expect, it } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import { CrlTargetListItem } from "../../src/http/schemas.ts";
import { cert, crlEntry, fixture, NOW } from "../fixtures/pki.ts";
import { DEFAULT_TARGETS, downloadsOf } from "../helpers/publish.ts";
import { okJson, readService } from "../helpers/reads.ts";

const LIST = "/api/v1/crls";
const ISSUING = "issuing-ca-1";
const FULL_ADCS = "crls/issuing-ca-1/full-adcs.der";
const DELTA_ADCS = "crls/issuing-ca-1/delta-adcs.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

/** Published: issuing-ca-1 full and delta (AD CS style), root-ca full (no entries). */
const PUBLISHED = [FULL_ADCS, DELTA_ADCS, ROOT_FULL_01];

const service = await readService({ publish: PUBLISHED });

function targetOf(file: string): string {
  const entry = crlEntry(file);
  return service.setup.target(entry.issuer, entry.kind);
}

async function list() {
  return okJson(await service.app.request(LIST), CrlTargetListItem.array());
}

describe("GET /api/v1/crls", () => {
  it("lists every configured target in targetId order, unpublished ones with current: null", async () => {
    const items = await list();
    const ids = DEFAULT_TARGETS.map((spec) => service.setup.target(spec.issuer, spec.kind));
    expect(items.map((item) => item.targetId)).toEqual(ids.sort());
    const publishedIds = new Set(PUBLISHED.map((file) => targetOf(file)));
    for (const item of items) {
      expect(item.current === null, item.targetId).toBe(!publishedIds.has(item.targetId));
    }
  });

  it("carries kind, label, issuer, downloads and the current CRL without its key", async () => {
    const { catalog } = await readState(service.base);
    const targetId = targetOf(FULL_ADCS);
    const issuer = cert(ISSUING).sha256;
    const item = (await list()).find((each) => each.targetId === targetId);
    expect(item).toEqual({
      targetId,
      kind: "full",
      label: `${ISSUING} full`,
      issuer: {
        id: issuer,
        label: null,
        subjectCN: catalog.certificates[issuer]?.summary.subjectCN,
      },
      downloads: downloadsOf(ISSUING, "full"),
      current: {
        sha256: crlEntry(FULL_ADCS).sha256,
        size: fixture(FULL_ADCS).byteLength,
        publishedAt: NOW.toISOString(),
        verifier: issuer,
        summary: catalog.targets[targetId]?.current?.summary,
      },
    });
    expect(item?.current?.summary.nextPublish).toBe(
      new Date(crlEntry(FULL_ADCS).nextPublish!).toISOString()
    );
  });
});
