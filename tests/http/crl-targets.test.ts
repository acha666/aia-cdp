// GET /api/v1/crls and /api/v1/crls/{targetId} (implementation slice 5a steps 5–7), on state built
// through importCertificate / applyConfig / publishCrl: published and unpublished targets
// (`current: null`, §10 #7), the issuer of §10 #10, every revoked entry (the v2 builder's page of
// 10 is gone), the target id parameter, 404, the 500s of §10 #9, no-store (§10 #17) and HEAD.
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, CONFIG_KEY } from "../../src/core/catalog.ts";
import type { CrlKind } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { parseCRL } from "../../src/core/pki/parsers.ts";
import { crlBlobKey } from "../../src/core/publish.ts";
import { buildCrlSummary } from "../../src/core/summary/catalog-summary.ts";
import { buildTBSCertList } from "../../src/core/summary/crl.ts";
import { CrlTargetDetail, CrlTargetListItem } from "../../src/http/schemas.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { logRecords } from "../helpers/app.ts";
import { cert, crlEntry, putCatalog } from "../helpers/catalog.ts";
import { crlWithEntries } from "../helpers/pki.ts";
import { DEFAULT_TARGETS, ISSUING_FULL_ALIAS, targetPath } from "../helpers/publish.ts";
import {
  errorOf,
  expectHead,
  expectInternal,
  okJson,
  readService,
  recordReads,
  stateOf,
} from "../helpers/reads.ts";
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
  return CrlTargetListItem.array().parse(await okJson(await service.app.request(LIST)));
}

async function detail(service: ReadService, targetId: string) {
  const body = await okJson(await service.app.request(`${LIST}/${targetId}`));
  // parse() drops keys the schema does not know: equal means no store key or v2 field leaked.
  expect(CrlTargetDetail.parse(body)).toEqual(body);
  return CrlTargetDetail.parse(body);
}

/** The download paths of a target of the shared setup (ISSUING_FULL_ALIAS sorts first). */
function downloadsOf(issuer: string, kind: CrlKind): string[] {
  const path = targetPath({ issuer, kind });
  const paths = issuer === ISSUING && kind === "full" ? [ISSUING_FULL_ALIAS, path] : [path];
  return paths.flatMap((each) => [each, `${each}.pem`]);
}

describe("GET /api/v1/crls", () => {
  it("lists every configured target in targetId order, each matching CrlTargetListItem", async () => {
    const service = await published();
    const body = await okJson(await service.app.request(LIST));
    expect(CrlTargetListItem.array().parse(body)).toEqual(body);
    const ids = DEFAULT_TARGETS.map((spec) => service.setup.target(spec.issuer, spec.kind));
    expect((await list(service)).map((item) => item.targetId)).toEqual(ids.sort());
  });

  it("carries kind, label, issuer, downloads and the current summary without key or verifier", async () => {
    const service = await published();
    const { catalog } = await stateOf(service);
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

  it("gives every unpublished target current: null", async () => {
    const service = await published();
    const publishedIds = new Set(PUBLISHED.map((file) => targetOf(service, file)));
    const items = await list(service);
    expect(items).toHaveLength(DEFAULT_TARGETS.length);
    for (const item of items) {
      if (publishedIds.has(item.targetId)) {
        expect(item.current).not.toBeNull();
      } else {
        expect(item.current).toBeNull();
      }
    }
  });

  it("answers HEAD with the headers and no body", async () => {
    const service = await published();
    await expectHead(await service.app.request(LIST, { method: "HEAD" }));
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

  it("returns all 11 entries of a CRL written straight into blob and catalog", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    // The re-encoded CRL is not signed by its issuer any more: it can only get here this way.
    const der = crlWithEntries(11);
    const sha256 = await sha256Hex(der);
    const summary = await buildCrlSummary(parseCRL(der), der);
    const key = crlBlobKey(targetId, summary, sha256);
    await service.base.put(key, der);
    const { catalog } = await stateOf(service);
    const verifier = cert(ISSUING).sha256;
    const current = {
      sha256,
      key,
      size: der.byteLength,
      publishedAt: NOW.toISOString(),
      verifier,
      summary,
    };
    await putCatalog(service.base, {
      ...catalog,
      targets: { ...catalog.targets, [targetId]: { current } },
    });

    const body = await detail(service, targetId);
    const { count, items } = body.current!.tbsCertList.revokedCertificates;
    expect(count).toBe(11);
    expect(count).toBe(body.current?.summary.revokedCount);
    expect(items.map((item) => item.userCertificate.decimal)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1))
    );
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
    expect((upper as { targetId: string }).targetId).toBe(targetId);
  });

  // RFC 9562 §5.10. zod's UUID pattern spells the Max UUID in lowercase only, so the parameter is
  // lowercased before the check, not after it.
  it("normalises the uppercase Max UUID", async () => {
    const max = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const service = await readService({
      setup: {
        configure: (config) => {
          const [targetId, target] = Object.entries(config.targets)[0]!;
          delete config.targets[targetId];
          config.targets[max] = target;
          for (const path of Object.values(config.paths)) {
            if ("target" in path && path.target === targetId) {
              path.target = max;
            }
          }
        },
      },
    });
    const upper = await okJson(await service.app.request(`${LIST}/${max.toUpperCase()}`));
    expect(upper).toEqual(await okJson(await service.app.request(`${LIST}/${max}`)));
    expect((upper as { targetId: string }).targetId).toBe(max);
  });

  it.each([
    ["not a UUID", "issuing-ca-1"],
    ["a UUID without dashes", "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"],
    ["a UUID in braces", "%7B0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d%7D"],
    ["version 9", "0a1b2c3d-4e5f-9a6b-8c7d-9e0f1a2b3c4d"],
    ["an archive-style id (§10 #2)", "crl%2Farchive%2Fissuing-ca-1.crl"],
    ["a certificate id", "a".repeat(64)],
    ["a malformed escape", "%ZZ"],
  ])("rejects %s with 400 bad_request", async (_case, id) => {
    const service = await published();
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 400, "bad_request");
    expect(error.details).toMatchObject({ target: "param" });
  });

  it("answers 404 for a UUID that config.json does not define", async () => {
    const service = await published();
    for (const id of [crypto.randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
      await errorOf(await service.app.request(`${LIST}/${id}`), 404, "not_found");
    }
    // An archive-style path is no route at all.
    await errorOf(await service.app.request(`${LIST}/crl/archive/x.crl`), 404, "not_found");
  });

  it("reads config.json and catalog.json once each, the current blob only when published", async () => {
    const service = await readService({ publish: PUBLISHED, wrap: recordReads });
    const store = service.deps.store as ReturnType<typeof recordReads>;
    const targetId = targetOf(service, FULL_ADCS);
    await detail(service, targetId);
    const { catalog } = await stateOf(service);
    expect(store.gets.slice(0, 2).sort()).toEqual([CATALOG_KEY, CONFIG_KEY].sort());
    expect(store.gets.slice(2)).toEqual([catalog.targets[targetId]?.current?.key]);

    store.gets.length = 0;
    await detail(service, service.setup.target("issuing-ca-2", "full"));
    expect(store.gets.sort()).toEqual([CATALOG_KEY, CONFIG_KEY].sort());
    expect(store.lists).toEqual([]);
  });

  it("answers 500 for a published target whose blob is gone, without leaking the key", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    const key = (await stateOf(service)).catalog.targets[targetId]?.current?.key ?? "";
    await service.base.delete(key);
    await expectInternal(await service.app.request(`${LIST}/${targetId}`), key);
    expect(logRecords(service.deps).slice(-2)).toEqual([
      expect.objectContaining({ msg: "read_inconsistent", reason: "blob_missing", key }),
      expect.objectContaining({ msg: "request", status: 500 }),
    ]);
  });

  it("answers 500 on list and detail when a target's issuer is missing from the catalog", async () => {
    const service = await published();
    const { catalog } = await stateOf(service);
    const issuer = cert("issuing-ca-2").sha256;
    const { [issuer]: _removed, ...certificates } = catalog.certificates;
    await putCatalog(service.base, { ...catalog, certificates });
    const targetId = service.setup.target("issuing-ca-2", "delta");
    for (const path of [LIST, `${LIST}/${targetId}`]) {
      await expectInternal(await service.app.request(path), issuer);
      expect(logRecords(service.deps).at(-2)).toMatchObject({
        msg: "read_inconsistent",
        reason: "issuer_missing",
        issuer,
      });
    }
  });

  it("answers HEAD with the headers and no body", async () => {
    const service = await published();
    const targetId = targetOf(service, FULL_ADCS);
    await expectHead(await service.app.request(`${LIST}/${targetId}`, { method: "HEAD" }));
  });
});
