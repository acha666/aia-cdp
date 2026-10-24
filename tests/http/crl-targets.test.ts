// GET /api/v1/crls and /api/v1/crls/{targetId}, on state built through importCertificate /
// applyConfig / publishCrl: published and unpublished targets (`current: null`), their issuer,
// every revoked entry, the target id parameter, 404 and the 500 of a blob the store lost.
import { describe, expect, it } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import { parseCRL } from "../../src/core/pki/parsers.ts";
import { buildTBSCertList } from "../../src/core/summary/crl.ts";
import { CrlTargetDetail, CrlTargetListItem } from "../../src/http/schemas.ts";
import { cert, crlEntry, fixture, NOW } from "../fixtures/pki.ts";
import { logRecords } from "../helpers/app.ts";
import { DEFAULT_TARGETS, downloadsOf } from "../helpers/publish.ts";
import { errorOf, expectInternal, okJson, readService } from "../helpers/reads.ts";
import type { ReadService } from "../helpers/reads.ts";

const LIST = "/api/v1/crls";
const ISSUING = "issuing-ca-1";
const FULL_ADCS = "crls/issuing-ca-1/full-adcs.der";
const DELTA_ADCS = "crls/issuing-ca-1/delta-adcs.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

/** Published: issuing-ca-1 full and delta (AD CS style), root-ca full (no entries). */
const PUBLISHED = [FULL_ADCS, DELTA_ADCS, ROOT_FULL_01];

function published(): Promise<ReadService> {
  return readService({ publish: PUBLISHED });
}

function targetOf(service: ReadService, file: string): string {
  const entry = crlEntry(file);
  return service.setup.target(entry.issuer, entry.kind);
}

async function list(service: ReadService) {
  return okJson(await service.app.request(LIST), CrlTargetListItem.array());
}

async function detail(service: ReadService, targetId: string) {
  return okJson(await service.app.request(`${LIST}/${targetId}`), CrlTargetDetail);
}

describe("GET /api/v1/crls", () => {
  it("lists every configured target in targetId order, unpublished ones with current: null", async () => {
    const service = await published();
    const items = await list(service);
    const ids = DEFAULT_TARGETS.map((spec) => service.setup.target(spec.issuer, spec.kind));
    expect(items.map((item) => item.targetId)).toEqual(ids.sort());
    const publishedIds = new Set(PUBLISHED.map((file) => targetOf(service, file)));
    for (const item of items) {
      expect(item.current === null, item.targetId).toBe(!publishedIds.has(item.targetId));
    }
  });

  it("carries kind, label, issuer, downloads and the current summary without key or verifier", async () => {
    const service = await published();
    const { catalog } = await readState(service.base);
    const targetId = targetOf(service, FULL_ADCS);
    const issuer = cert(ISSUING).sha256;
    const item = (await list(service)).find((each) => each.targetId === targetId);
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
        summary: catalog.targets[targetId]?.current?.summary,
      },
    });
    expect(item?.current?.summary.nextPublish).toBe(
      new Date(crlEntry(FULL_ADCS).nextPublish!).toISOString()
    );
  });
});

describe("GET /api/v1/crls/{targetId}", () => {
  it("is the list item plus verifier, fingerprints, TBSCertList and the signature", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    const body = await detail(service, targetId);
    const item = (await list(service)).find((each) => each.targetId === targetId);
    expect(body).toMatchObject({ ...item, current: item?.current });
    expect(body.current?.verifier).toBe(cert(ISSUING).sha256);
    expect(body.current?.fingerprints).toEqual({
      sha1: item?.current?.summary.sha1,
      sha256: crlEntry(FULL_ADCS).sha256,
    });
    expect(body.current?.tbsCertList).toEqual(
      JSON.parse(JSON.stringify(buildTBSCertList(parseCRL(fixture(FULL_ADCS)))))
    );
    expect(body.current?.signatureAlgorithm).toEqual(body.current?.tbsCertList.signature);
  });

  it("returns every revoked entry: revokedCertificates.count === summary.revokedCount", async () => {
    const service = await published();
    for (const file of PUBLISHED) {
      const { current } = await detail(service, targetOf(service, file));
      const { count, items } = current!.tbsCertList.revokedCertificates;
      expect(count, file).toBe(current?.summary.revokedCount);
      expect(count, file).toBe(crlEntry(file).revoked);
      expect(items).toHaveLength(count);
    }
  });

  it("answers 200 with current: null for a configured target without a CRL", async () => {
    const service = await published();
    const targetId = service.setup.target("issuing-ca-2", "full");
    const body = await detail(service, targetId);
    expect(body.current).toBeNull();
    expect(body).toEqual((await list(service)).find((each) => each.targetId === targetId));
  });

  it("normalises an uppercase target id", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    const upper = await okJson(await service.app.request(`${LIST}/${targetId.toUpperCase()}`));
    expect(upper).toEqual(await okJson(await service.app.request(`${LIST}/${targetId}`)));
  });

  it.each([
    ["not a UUID", "issuing-ca-1"],
    ["a UUID without dashes", "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"],
    ["a certificate id", "a".repeat(64)],
    ["a malformed escape", "%ZZ"],
  ])("rejects %s with 400 bad_request", async (_case, id) => {
    const service = await published();
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 400, "bad_request");
    expect(error.details).toMatchObject({ target: "param" });
  });

  it("answers 404 for a UUID that config.json does not define", async () => {
    const service = await published();
    await errorOf(await service.app.request(`${LIST}/${crypto.randomUUID()}`), 404, "not_found");
  });

  it("answers 500 for a published target whose blob is gone, without leaking the key", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    const key = (await readState(service.base)).catalog.targets[targetId]?.current?.key ?? "";
    await service.base.delete(key);
    await expectInternal(await service.app.request(`${LIST}/${targetId}`), key);
    expect(logRecords(service.deps).at(-2)).toMatchObject({
      msg: "unhandled_error",
      error: { message: `The store has no blob ${key}` },
    });
  });
});
