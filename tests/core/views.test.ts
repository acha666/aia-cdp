import { describe, expect, it } from "vitest";
import { CatalogSchema, ConfigSchema } from "../../src/core/catalog.ts";
import type { Catalog, Config, CrlKind } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { PkiParseError } from "../../src/core/pki/errors.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import { crlBlobKey } from "../../src/core/publish.ts";
import { buildCrlSummary } from "../../src/core/summary/catalog-summary.ts";
import { buildTBSCertificate } from "../../src/core/summary/certificate.ts";
import { buildTBSCertList } from "../../src/core/summary/crl.ts";
import {
  certificateDetail,
  certificateList,
  crlTargetDetail,
  crlTargetList,
  findCertificate,
  findCrlTarget,
  stats,
} from "../../src/core/views.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { cert, certificateEntry, crlEntry, currentCrl } from "../helpers/catalog.ts";
import { crlWithEntries } from "../helpers/pki.ts";

// The read model of slice 5a step 5, row by row, on config / catalog values built from the
// fixtures (views are pure: no store). Intent of worker-aia-cdp@5b570aa:tests/worker/
// api-stats.test.ts: counts by resource, not by stored object.

const ROOT = "root-ca";
const ISSUING = "issuing-ca-1";
const ISSUING_2 = "issuing-ca-2";
const FULL_ADCS = "crls/issuing-ca-1/full-adcs.der";
const DELTA_ADCS = "crls/issuing-ca-1/delta-adcs.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

// Target ids are assigned by the operator; these are listed in reverse to check the order.
const T_ROOT = "00000000-0000-4000-8000-000000000001";
const T_ISSUING_DELTA = "00000000-0000-4000-8000-000000000002";
const T_ISSUING_FULL = "00000000-0000-4000-8000-000000000003";
const T_UNPUBLISHED = "00000000-0000-4000-8000-000000000004";

const ROOT_LABEL = "Example Root";

interface TargetSpec {
  id: string;
  issuer: string;
  kind: CrlKind;
  label: string;
  path: string;
  /** The CRL fixture published to the target, if any. */
  published?: string;
}

const TARGETS: TargetSpec[] = [
  {
    id: T_UNPUBLISHED,
    issuer: ISSUING_2,
    kind: "full",
    label: "Issuing CA 2",
    path: "/crl/issuing-ca-2.crl",
  },
  {
    id: T_ISSUING_FULL,
    issuer: ISSUING,
    kind: "full",
    label: "Issuing CA 1",
    path: "/crl/issuing-ca-1.crl",
    published: FULL_ADCS,
  },
  {
    id: T_ISSUING_DELTA,
    issuer: ISSUING,
    kind: "delta",
    label: "Issuing CA 1 delta",
    path: "/dcrl/issuing-ca-1.crl",
    published: DELTA_ADCS,
  },
  {
    id: T_ROOT,
    issuer: ROOT,
    kind: "full",
    label: "Root",
    path: "/crl/root-ca.crl",
    published: ROOT_FULL_01,
  },
];

function target(id: string): TargetSpec {
  const found = TARGETS.find((spec) => spec.id === id);
  if (found === undefined) {
    throw new Error(`no target ${id}`);
  }
  return found;
}

/**
 * Three certificates imported (issuing-ca-2 first, so that the catalog's insertion order is not the
 * id order), only the root labelled and served (two paths, the alias sorting first); the four
 * targets of TARGETS with their CRLs published. Both objects pass their stored schemas.
 */
async function state(): Promise<{ config: Config; catalog: Catalog }> {
  const config: Config = {
    version: 1,
    certificates: { [cert(ROOT).sha256]: { label: ROOT_LABEL } },
    targets: {},
    paths: {
      "/ca/root-ca.crt": { certificate: cert(ROOT).sha256 },
      "/ca/root-ca-alias.crt": { certificate: cert(ROOT).sha256 },
    },
  };
  const catalog: Catalog = { version: 1, certificates: {}, targets: {} };
  for (const name of [ISSUING_2, ROOT, ISSUING]) {
    const { id, entry } = await certificateEntry(name);
    catalog.certificates[id] = entry;
  }
  for (const spec of TARGETS) {
    config.targets[spec.id] = {
      issuer: cert(spec.issuer).sha256,
      kind: spec.kind,
      label: spec.label,
    };
    config.paths[spec.path] = { target: spec.id };
    if (spec.published !== undefined) {
      catalog.targets[spec.id] = { current: await currentCrl(spec.published, spec.id) };
    }
  }
  return { config: ConfigSchema.parse(config), catalog: CatalogSchema.parse(catalog) };
}

describe("certificateList", () => {
  it("lists every catalog certificate once, in id order", async () => {
    const { config, catalog } = await state();
    const ids = certificateList(config, catalog).map((item) => item.id);
    expect(ids).toEqual(Object.keys(catalog.certificates).sort());
    expect(ids).toHaveLength(3);
    expect(Object.keys(catalog.certificates)).not.toEqual(ids);
  });

  it("is id, label, importedAt, size, the catalog summary as is, downloads and targets", async () => {
    const { config, catalog } = await state();
    const root = cert(ROOT);
    const entry = catalog.certificates[root.sha256]!;
    const item = certificateList(config, catalog).find((each) => each.id === root.sha256);
    expect(item).toEqual({
      id: root.sha256,
      label: ROOT_LABEL,
      importedAt: NOW.toISOString(),
      size: fixture(root.der).byteLength,
      summary: entry.summary,
      downloads: [
        "/ca/root-ca-alias.crt",
        "/ca/root-ca-alias.crt.pem",
        "/ca/root-ca.crt",
        "/ca/root-ca.crt.pem",
      ],
      targets: [{ targetId: T_ROOT, kind: "full", label: target(T_ROOT).label }],
    });
  });

  it("gives an unlabelled certificate label null and an unserved one downloads []", async () => {
    const { config, catalog } = await state();
    const item = certificateList(config, catalog).find((each) => each.id === cert(ISSUING).sha256);
    expect(item?.label).toBeNull();
    expect(item?.downloads).toEqual([]);
  });

  it("names the targets the certificate issues for, in targetId order (§10 #10)", async () => {
    const { config, catalog } = await state();
    const byId = new Map(certificateList(config, catalog).map((item) => [item.id, item.targets]));
    expect(byId.get(cert(ISSUING).sha256)).toEqual([
      { targetId: T_ISSUING_DELTA, kind: "delta", label: target(T_ISSUING_DELTA).label },
      { targetId: T_ISSUING_FULL, kind: "full", label: target(T_ISSUING_FULL).label },
    ]);
    expect(byId.get(cert(ISSUING_2).sha256)).toEqual([
      { targetId: T_UNPUBLISHED, kind: "full", label: target(T_UNPUBLISHED).label },
    ]);
  });

  it("lists the catalog alone without config.json: no labels, downloads or targets", async () => {
    const { catalog } = await state();
    const items = certificateList(null, catalog);
    expect(items.map((item) => item.id)).toEqual(Object.keys(catalog.certificates).sort());
    for (const item of items) {
      expect(item).toMatchObject({ label: null, downloads: [], targets: [] });
    }
  });
});

describe("certificateDetail", () => {
  it("is the list item plus fingerprints, TBSCertificate, signature algorithm and value", async () => {
    const { config, catalog } = await state();
    const issuing = cert(ISSUING);
    const der = fixture(issuing.der);
    const source = findCertificate(config, catalog, issuing.sha256)!;
    expect(source.key).toBe(catalog.certificates[issuing.sha256]?.key);
    const detail = await certificateDetail(source, der);
    const item = certificateList(config, catalog).find((each) => each.id === issuing.sha256);
    // Every section, every time (§10 #28): the v2 include= switch is gone.
    expect(Object.keys(detail).sort()).toEqual(
      [
        ...Object.keys(item!),
        "fingerprints",
        "tbsCertificate",
        "signatureAlgorithm",
        "signatureValue",
      ].sort()
    );
    expect(detail).toMatchObject(item!);
    expect(detail.fingerprints).toEqual({
      sha1: catalog.certificates[issuing.sha256]?.summary.sha1,
      sha256: issuing.sha256,
    });
    expect(detail.tbsCertificate).toEqual(await buildTBSCertificate(parseCertificate(der)));
    expect(detail.tbsCertificate.serialNumber.hex).toBe(issuing.serial);
    expect(detail.tbsCertificate.extensions?.count).toBeGreaterThan(0);
    // Signed by the EC P-384 root (§10 #8: the outer algorithm, with an ECDSA (r, s)). Import
    // rejects a certificate whose outer algorithm is not its TBS signature octet for octet
    // (tests/core/import.test.ts), so no stored certificate tells the two apart.
    expect(detail.signatureAlgorithm).toEqual({
      algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
    });
    expect(detail.signatureValue.parsed?.type).toBe("ecdsa");
    for (const part of [detail.signatureValue.parsed?.r, detail.signatureValue.parsed?.s]) {
      expect(part).toMatch(/^[0-9A-F]{1,96}$/i);
      expect(part).not.toMatch(/^00/);
    }
  });

  it("decodes an Ed25519 self-signature, without (r, s)", async () => {
    // The fixture CA certificates are signed by the EC root or by themselves; the RSA signature
    // algorithm is checked on an issuing-ca-1 CRL (crlTargetDetail below).
    const name = "ed25519-ca";
    const der = fixture(cert(name).der);
    const { id, entry } = await certificateEntry(name);
    const catalog: Catalog = { version: 1, certificates: { [id]: entry }, targets: {} };
    const detail = await certificateDetail(findCertificate(null, catalog, id)!, der);
    expect(detail.signatureAlgorithm).toEqual({
      algorithm: { oid: "1.3.101.112", name: "Ed25519" },
    });
    expect(detail.signatureValue.parsed).toBeUndefined();
  });

  it("throws for a missing blob, another certificate's bytes and bytes that do not parse", async () => {
    const { config, catalog } = await state();
    const source = findCertificate(config, catalog, cert(ISSUING).sha256)!;
    await expect(certificateDetail(source, null)).rejects.toThrow("has no blob");
    await expect(certificateDetail(source, fixture(cert(ROOT).der))).rejects.toThrow(
      "does not have the catalog's SHA-256"
    );
    // The digest is compared before parsing: foreign bytes that do not parse are a mismatch too.
    await expect(
      certificateDetail(source, new TextEncoder().encode("not this certificate"))
    ).rejects.toThrow("does not have the catalog's SHA-256");
    // A catalog entry whose id is the digest of bytes that are no certificate.
    const garbage = new TextEncoder().encode("not a certificate");
    const id = await sha256Hex(garbage);
    const { entry } = await certificateEntry(ISSUING);
    const broken: Catalog = {
      version: 1,
      certificates: { [id]: { ...entry, key: `blobs/certificates/${id}.der` } },
      targets: {},
    };
    const garbageSource = findCertificate(null, broken, id)!;
    await expect(certificateDetail(garbageSource, garbage)).rejects.toThrow(PkiParseError);
  });

  it("finds catalog ids only", async () => {
    const { config, catalog } = await state();
    expect(findCertificate(config, catalog, "0".repeat(64))).toBeUndefined();
  });
});

describe("crlTargetList", () => {
  it("lists every configured target once, in targetId order", async () => {
    const { config, catalog } = await state();
    expect(crlTargetList(config, catalog).map((item) => item.targetId)).toEqual([
      T_ROOT,
      T_ISSUING_DELTA,
      T_ISSUING_FULL,
      T_UNPUBLISHED,
    ]);
  });

  it("is targetId, kind, label, issuer, downloads and the current CRL without key or verifier", async () => {
    const { config, catalog } = await state();
    const item = crlTargetList(config, catalog).find((each) => each.targetId === T_ISSUING_FULL);
    const current = catalog.targets[T_ISSUING_FULL]!.current!;
    expect(item).toEqual({
      targetId: T_ISSUING_FULL,
      kind: "full",
      label: target(T_ISSUING_FULL).label,
      issuer: {
        id: cert(ISSUING).sha256,
        label: null,
        subjectCN: catalog.certificates[cert(ISSUING).sha256]?.summary.subjectCN,
      },
      downloads: ["/crl/issuing-ca-1.crl", "/crl/issuing-ca-1.crl.pem"],
      current: {
        sha256: crlEntry(FULL_ADCS).sha256,
        size: fixture(FULL_ADCS).byteLength,
        publishedAt: NOW.toISOString(),
        summary: current.summary,
      },
    });
  });

  it("carries the issuer's config label and the kind from config.json", async () => {
    const { config, catalog } = await state();
    const items = crlTargetList(config, catalog);
    expect(items.find((each) => each.targetId === T_ROOT)?.issuer).toEqual({
      id: cert(ROOT).sha256,
      label: ROOT_LABEL,
      subjectCN: catalog.certificates[cert(ROOT).sha256]?.summary.subjectCN,
    });
    expect(items.find((each) => each.targetId === T_ISSUING_DELTA)?.kind).toBe("delta");
  });

  it("gives an unpublished target current: null", async () => {
    const { config, catalog } = await state();
    const item = crlTargetList(config, catalog).find((each) => each.targetId === T_UNPUBLISHED);
    expect(item?.current).toBeNull();
  });

  it("always carries current.summary.nextPublish: the AD CS time, or null", async () => {
    const { config, catalog } = await state();
    const items = crlTargetList(config, catalog);
    const nextPublish = crlEntry(FULL_ADCS).nextPublish;
    expect(nextPublish).not.toBeNull();
    expect(items.find((each) => each.targetId === T_ISSUING_FULL)?.current?.summary).toMatchObject({
      nextPublish: new Date(nextPublish!).toISOString(),
    });
    expect(crlEntry(ROOT_FULL_01).nextPublish).toBeNull();
    expect(items.find((each) => each.targetId === T_ROOT)?.current?.summary.nextPublish).toBeNull();
  });

  it("has a non-null revokedCount for every published target (§10 #7)", async () => {
    const { config, catalog } = await state();
    for (const item of crlTargetList(config, catalog)) {
      const file = target(item.targetId).published;
      if (file === undefined) {
        expect(item.current).toBeNull();
      } else {
        expect(item.current?.summary.revokedCount).toBe(crlEntry(file).revoked);
      }
    }
  });

  it("is [] without config.json, and leaves out a current whose target config.json lacks", async () => {
    const { config, catalog } = await state();
    expect(crlTargetList(null, catalog)).toEqual([]);
    const { [T_ROOT]: _removed, ...targets } = config.targets;
    const withoutRoot = { ...config, targets };
    expect(crlTargetList(withoutRoot, catalog).map((item) => item.targetId)).not.toContain(T_ROOT);
    expect(catalog.targets[T_ROOT]?.current).not.toBeNull();
  });

  it("throws when a target's issuer is not in the catalog", async () => {
    const { config, catalog } = await state();
    const { [cert(ISSUING_2).sha256]: _removed, ...certificates } = catalog.certificates;
    const broken = { ...catalog, certificates };
    expect(() => crlTargetList(config, broken)).toThrow("which is not in the catalog");
    expect(() => findCrlTarget(config, broken, T_UNPUBLISHED)).toThrow(
      "which is not in the catalog"
    );
  });
});

describe("crlTargetDetail", () => {
  it("is the list item plus verifier, fingerprints, TBSCertList and the signature", async () => {
    const { config, catalog } = await state();
    const der = fixture(FULL_ADCS);
    const source = findCrlTarget(config, catalog, T_ISSUING_FULL)!;
    const current = catalog.targets[T_ISSUING_FULL]!.current!;
    expect(source.current).toEqual(current);
    const detail = await crlTargetDetail(source, der);
    const item = crlTargetList(config, catalog).find((each) => each.targetId === T_ISSUING_FULL)!;
    expect(detail).toMatchObject({ ...item, current: item.current });
    expect(Object.keys(detail.current ?? {}).sort()).toEqual(
      [
        "sha256",
        "size",
        "publishedAt",
        "summary",
        "verifier",
        "fingerprints",
        "tbsCertList",
        "signatureAlgorithm",
        "signatureValue",
      ].sort()
    );
    expect(detail.current?.verifier).toBe(cert(ISSUING).sha256);
    expect(detail.current?.fingerprints).toEqual({
      sha1: current.summary.sha1,
      sha256: crlEntry(FULL_ADCS).sha256,
    });
    expect(detail.current?.tbsCertList).toEqual(buildTBSCertList(parseCRL(der)));
    // RSA-2048 issuing CA: the outer algorithm equals the TBSCertList's, without a parsed (r, s).
    expect(detail.current?.signatureAlgorithm).toEqual(detail.current?.tbsCertList.signature);
    expect(detail.current?.signatureAlgorithm.algorithm.name).toBe("sha256WithRSAEncryption");
    expect(detail.current?.signatureValue.parsed).toBeUndefined();
    expect(detail.current?.signatureValue.unusedBits).toBe(0);
  });

  it("returns every revoked entry; the count equals the summary's revokedCount", async () => {
    const { config, catalog } = await state();
    const detail = await crlTargetDetail(
      findCrlTarget(config, catalog, T_ISSUING_FULL)!,
      fixture(FULL_ADCS)
    );
    const { count, items } = detail.current!.tbsCertList.revokedCertificates;
    expect(count).toBe(crlEntry(FULL_ADCS).revoked);
    expect(items).toHaveLength(count);
    expect(count).toBe(detail.current?.summary.revokedCount);
  });

  it("gives an empty CRL revokedCertificates { count: 0, items: [] }", async () => {
    const { config, catalog } = await state();
    expect(crlEntry(ROOT_FULL_01).revoked).toBe(0);
    const detail = await crlTargetDetail(
      findCrlTarget(config, catalog, T_ROOT)!,
      fixture(ROOT_FULL_01)
    );
    expect(detail.current?.tbsCertList.revokedCertificates).toEqual({ count: 0, items: [] });
    expect(detail.current?.signatureValue.parsed?.type).toBe("ecdsa");
  });

  it("returns all 11 entries of a re-encoded CRL (more than the v2 page of 10)", async () => {
    const { config, catalog } = await state();
    const der = crlWithEntries(11);
    const sha256 = await sha256Hex(der);
    const summary = await buildCrlSummary(parseCRL(der), der);
    const current = {
      sha256,
      key: crlBlobKey(T_ISSUING_FULL, summary, sha256),
      size: der.byteLength,
      publishedAt: NOW.toISOString(),
      verifier: cert(ISSUING).sha256,
      summary,
    };
    const eleven = CatalogSchema.parse({
      ...catalog,
      targets: { ...catalog.targets, [T_ISSUING_FULL]: { current } },
    });
    const detail = await crlTargetDetail(findCrlTarget(config, eleven, T_ISSUING_FULL)!, der);
    const { count, items } = detail.current!.tbsCertList.revokedCertificates;
    expect(count).toBe(11);
    expect(items.map((item) => item.userCertificate.decimal)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1))
    );
    expect(count).toBe(summary.revokedCount);
  });

  it("is the list item with current: null for an unpublished target, whatever the bytes", async () => {
    const { config, catalog } = await state();
    const source = findCrlTarget(config, catalog, T_UNPUBLISHED)!;
    expect(source.current).toBeNull();
    const item = crlTargetList(config, catalog).find((each) => each.targetId === T_UNPUBLISHED);
    expect(await crlTargetDetail(source, null)).toEqual(item);
  });

  it("throws for a missing blob, another CRL's bytes and bytes that do not parse", async () => {
    const { config, catalog } = await state();
    const source = findCrlTarget(config, catalog, T_ISSUING_FULL)!;
    await expect(crlTargetDetail(source, null)).rejects.toThrow("has no blob");
    await expect(crlTargetDetail(source, fixture(DELTA_ADCS))).rejects.toThrow(
      "does not have the catalog's SHA-256"
    );
    // The digest is compared before parsing: foreign bytes that do not parse are a mismatch too.
    await expect(crlTargetDetail(source, new TextEncoder().encode("not this CRL"))).rejects.toThrow(
      "does not have the catalog's SHA-256"
    );
    const garbage = new TextEncoder().encode("not a CRL");
    const current = { ...source.current!, sha256: await sha256Hex(garbage) };
    await expect(crlTargetDetail({ ...source, current }, garbage)).rejects.toThrow(PkiParseError);
  });

  it("finds configured targets only: none without config.json", async () => {
    const { config, catalog } = await state();
    expect(findCrlTarget(null, catalog, T_ROOT)).toBeUndefined();
    expect(findCrlTarget(config, catalog, "00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
  });
});

describe("stats", () => {
  // Like the CRL lists: the counts never describe a state the lists refuse to show.
  it("throws when a configured target's issuer is not in the catalog", async () => {
    const { config, catalog } = await state();
    const { [cert(ISSUING_2).sha256]: _removed, ...certificates } = catalog.certificates;
    expect(() => stats(config, { ...catalog, certificates })).toThrow(
      "which is not in the catalog"
    );
  });

  it("counts from config.json and catalog.json, with no time fields", async () => {
    const { config, catalog } = await state();
    const published = TARGETS.flatMap((spec) => (spec.published === undefined ? [] : [spec]));
    const result = stats(config, catalog);
    expect(Object.keys(result).sort()).toEqual(
      ["certificates", "derBytes", "published", "targets", "totalRevocations"].sort()
    );
    expect(result).toEqual({
      certificates: 3,
      targets: { full: 3, delta: 1 },
      published: { full: 2, delta: 1 },
      // Full CRLs only: the delta's entries reappear in the next full CRL.
      totalRevocations: crlEntry(FULL_ADCS).revoked + crlEntry(ROOT_FULL_01).revoked,
      derBytes:
        [ROOT, ISSUING, ISSUING_2].reduce((sum, name) => sum + fixture(cert(name).der).length, 0) +
        published.reduce((sum, spec) => sum + fixture(spec.published!).length, 0),
    });
    expect(crlEntry(DELTA_ADCS).revoked).toBeGreaterThan(0);
  });

  it("has totalRevocations null without a published full CRL, 0 for a full CRL without entries", async () => {
    const { config, catalog } = await state();
    const only = (ids: string[]): Catalog => ({
      ...catalog,
      targets: Object.fromEntries(ids.map((id) => [id, catalog.targets[id]!])),
    });
    expect(stats(config, only([T_ISSUING_DELTA])).totalRevocations).toBeNull();
    expect(stats(config, only([])).totalRevocations).toBeNull();
    expect(stats(config, only([T_ROOT])).totalRevocations).toBe(0);
  });

  it("counts certificates only without config.json; an unconfigured current is no resource", async () => {
    const { catalog } = await state();
    expect(stats(null, catalog)).toEqual({
      certificates: 3,
      targets: { full: 0, delta: 0 },
      published: { full: 0, delta: 0 },
      totalRevocations: null,
      derBytes: [ROOT, ISSUING, ISSUING_2].reduce(
        (sum, name) => sum + fixture(cert(name).der).length,
        0
      ),
    });
  });
});
