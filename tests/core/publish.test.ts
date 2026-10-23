import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConfig } from "../../src/core/admin.ts";
import {
  CATALOG_KEY,
  CatalogSchema,
  certificateBlobKey,
  CONFIG_KEY,
  ConfigSchema,
  CrlSummarySchema,
  decodeJson,
} from "../../src/core/catalog.ts";
import type { Catalog, CrlKind, CurrentCrl } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { importCertificate } from "../../src/core/import.ts";
import { SIGNATURE_ALG_NAMES } from "../../src/core/pki/constants.ts";
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
import { MAX_CRL_NUMBER_OCTETS } from "../../src/core/pki/extensions.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import { crlBlobKey, crlHistoryKey, crlVersionName, publishCrl } from "../../src/core/publish.ts";
import type { CurrentVersion, PublishLogRecord } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import {
  buildCertificateSummary,
  buildCrlSummary,
} from "../../src/core/summary/catalog-summary.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import type { ManifestCrl } from "../fixtures/pki.ts";
import { cert, currentCrl, putConfig } from "../helpers/catalog.ts";
import { generateCa, setupGeneratedCa, signCrl } from "../helpers/generated-ca.ts";
import {
  extension,
  nullWithContents,
  padOid,
  pkiError,
  withOuterAlgorithm,
} from "../helpers/pki.ts";
import {
  IMPORTED,
  ISSUING_FULL_ALIAS,
  publish,
  publishFile,
  racingStore,
  setupPublish,
  targetPath,
} from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { flakyStore, puts, recordingStore } from "../helpers/store.ts";

// publishCrl (slice 4 step 6) and the SKI rule as uploads see it (step 7). Every case starts from
// the shared setup unless it says otherwise: every `import: true` certificate imported, and
// applyConfig with full + delta targets for issuing-ca-1 and -2 and full targets for root-ca,
// ed25519-ca and ed448-ca. The helpers fail a case whose call logs anything but one record.
// Migrated: worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts:159-179 (malformed extension
// values) and the no-write assertions of tests/worker/crl-upload.test.ts:48-62, 266-276, 291-301,
// 341-349.

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const FULL_03 = "crls/issuing-ca-1/full-03.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";
const AKI_OID = "2.5.29.35";
const CRL_NUMBER_OID = "2.5.29.20";
const DELTA_INDICATOR_OID = "2.5.29.27";

/** The engine whose verifyWithPublicKey checks every signature (B21). */
const engine = pkijs.getCrypto(true);

afterEach(() => {
  vi.restoreAllMocks();
});

/** The manifest entry of a CRL fixture; a `.pem` file stands for its `.der`. */
function crlEntry(file: string): ManifestCrl {
  const der = file.replace(/(?:\.crlf)?\.pem$/, ".der");
  const found = manifest.crls.find((crl) => crl.file === der);
  if (!found) {
    throw new Error(`no manifest CRL ${der}`);
  }
  return found;
}

/** `details.current` of a 409 against the fixture `file`. */
function versionOf(file: string): CurrentVersion {
  const entry = crlEntry(file);
  return {
    sha256: entry.sha256,
    crlNumber: entry.crlNumber,
    thisUpdate: new Date(entry.thisUpdate).toISOString(),
  };
}

async function fresh(options?: SetupOptions) {
  const base = new MemoryStore();
  const setup = await setupPublish(base, options);
  return { base, setup };
}

async function storedCatalog(store: ObjectStore): Promise<Catalog> {
  const object = await store.get(CATALOG_KEY);
  if (object === null) {
    throw new Error("no catalog.json");
  }
  return CatalogSchema.parse(decodeJson(object.bytes));
}

async function currentOf(store: ObjectStore, targetId: string): Promise<CurrentCrl | null> {
  return (await storedCatalog(store)).targets[targetId]?.current ?? null;
}

async function keys(store: ObjectStore, prefix: string): Promise<string[]> {
  return (await store.list(prefix)).map((object) => object.key);
}

async function json(store: ObjectStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (object === null) {
    throw new Error(`no ${key}`);
  }
  return decodeJson(object.bytes);
}

/** The downloads of a target of the shared setup. */
function downloadsOf(issuer: string, kind: CrlKind): string[] {
  const path = targetPath({ issuer, kind });
  const paths = issuer === "issuing-ca-1" && kind === "full" ? [ISSUING_FULL_ALIAS, path] : [path];
  return paths.flatMap((each) => [each, `${each}.pem`]);
}

/**
 * full-01 with its CRL extensions changed by `edit` and the TBS re-encoded. The signature no
 * longer matches: only a rejection before the signature check can come out.
 */
function reencoded(edit: (extensions: pkijs.Extension[]) => pkijs.Extension[]): Uint8Array {
  const crl = parseCRL(fixture(FULL_01));
  crl.crlExtensions = new pkijs.Extensions({ extensions: edit(crl.crlExtensions!.extensions) });
  // toSchema is typed `any`; true re-encodes the TBS from the fields.
  const schema = crl.toSchema(true) as asn1.Sequence;
  return new Uint8Array(schema.toBER(false));
}

const replacing =
  (oid: string, replacement: pkijs.Extension) => (extensions: pkijs.Extension[]) => [
    ...extensions.filter((ext) => ext.extnID !== oid),
    replacement,
  ];

/** An extension whose extnValue is exactly `octets`. */
const rawExtension = (oid: string, octets: number[]) =>
  new pkijs.Extension({ extnID: oid, extnValue: Uint8Array.from(octets).buffer });

/** full-01's extension `oid` with one octet after its value: one DER value plus a trailing byte. */
const withTrailingByte = (oid: string) => (extensions: pkijs.Extension[]) =>
  extensions.map((ext) =>
    ext.extnID === oid ? rawExtension(oid, [...ext.extnValue.valueBlock.valueHexView, 0]) : ext
  );

describe("publishCrl: the first upload of each manifest CRL", () => {
  it.each(manifest.crls.map((crl) => [crl.file, crl.expect, crl] as const))(
    "%s → %s",
    async (file, expected, crl) => {
      const { base, setup } = await fresh();
      const store = recordingStore(base);
      const { result } = await publishFile(store, file);
      if (expected !== "created") {
        expect(result).toMatchObject({ error: expected });
        // M9: rejected before the first write.
        expect(store.writes).toEqual([]);
        return;
      }
      const targetId = setup.target(crl.issuer, crl.kind);
      const current = await currentCrl(file, targetId);
      expect(result).toEqual({
        outcome: "created",
        targetId,
        kind: crl.kind,
        issuer: cert(crl.issuer).sha256,
        current,
        downloads: downloadsOf(crl.issuer, crl.kind),
      });
      expect(await currentOf(base, targetId)).toEqual(current);
      expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
        [current.key, true],
        [CATALOG_KEY, true],
      ]);
    }
  );
});

describe("publishCrl: the manifest scenarios", () => {
  it.each(
    manifest.scenarios.map(
      (scenario) =>
        [scenario.current ?? "nothing", scenario.upload, scenario.outcome, scenario] as const
    )
  )("current %s, upload %s → %s", async (_current, upload, outcome, scenario) => {
    const { base, setup } = await fresh();
    const entry = crlEntry(upload);
    const targetId = setup.target(entry.issuer, entry.kind);
    let before: CurrentCrl | null = null;
    if (scenario.current !== null) {
      expect((await publishFile(base, scenario.current)).result).toMatchObject({
        outcome: "created",
        targetId,
      });
      before = await currentOf(base, targetId);
    }
    const catalogBefore = await base.get(CATALOG_KEY);
    const store = recordingStore(base);
    const { result } = await publishFile(store, upload);

    if (outcome === "created" || outcome === "updated") {
      const current = await currentCrl(entry.file, targetId);
      expect(result).toMatchObject({ outcome, targetId, current });
      expect(await currentOf(base, targetId)).toEqual(current);
      if (before !== null) {
        expect(await json(base, crlHistoryKey(targetId, before.summary, before.sha256))).toEqual(
          before
        );
      }
      return;
    }
    if (outcome === "unchanged") {
      expect(result).toEqual({
        outcome,
        targetId,
        kind: entry.kind,
        issuer: cert(entry.issuer).sha256,
        current: before,
        downloads: downloadsOf(entry.issuer, entry.kind),
      });
    } else {
      expect(result).toEqual({
        error: outcome,
        details: { current: versionOf(scenario.current!) },
      });
    }
    // M9: no write; the catalog is byte for byte the same.
    expect(store.writes).toEqual([]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(catalogBefore!.bytes);
  });
});

describe("publishCrl: input that is not a CRL", () => {
  it.each(manifest.invalid.map((invalid) => [invalid.file, invalid.note] as const))(
    "rejects %s (%s) as invalid_crl without writing",
    async (file) => {
      const { base } = await fresh();
      const store = recordingStore(base);
      const { result } = await publishFile(store, file);
      expect(result).toEqual({
        error: "invalid_crl",
        details: { reason: expect.any(String) as unknown },
      });
      expect(PKI_PARSE_REASONS).toContain(
        (result as { details: { reason: string } }).details.reason
      );
      expect(store.writes).toEqual([]);
    }
  );

  it("rejects full-bad-time with reason time (§10 #11, #25)", async () => {
    const { base } = await fresh();
    const store = recordingStore(base);
    const { result } = await publishFile(store, "crls/issuing-ca-1/full-bad-time.der");
    expect(result).toEqual({ error: "invalid_crl", details: { reason: "time" } });
    expect(store.writes).toEqual([]);
  });

  it("rejects a PEM block of another label, and two blocks", async () => {
    const { base } = await fresh();
    const store = recordingStore(base);
    const pem = (path: string) => new TextDecoder().decode(fixture(path));
    const encode = (text: string) => new TextEncoder().encode(text);
    expect((await publish(store, fixture(cert("root-ca").pem))).result).toEqual({
      error: "invalid_crl",
      details: { reason: "pem_label" },
    });
    const two = pem("crls/issuing-ca-1/full-01.pem") + pem("crls/root-ca/full-01.pem");
    expect((await publish(store, encode(two))).result).toEqual({
      error: "invalid_crl",
      details: { reason: "pem_blocks" },
    });
    expect(store.writes).toEqual([]);
  });

  // Exactly one INTEGER ≥ 0 (tag 2, not empty, at most MAX_CRL_NUMBER_OCTETS octets) for the CRL
  // Number and the Delta CRL Indicator, and exactly one AKI.
  it.each([
    [
      "CRL Number NULL",
      replacing(CRL_NUMBER_OID, extension(CRL_NUMBER_OID, new asn1.Null())),
      /Invalid CRL Number/,
    ],
    [
      "CRL Number -1",
      replacing(CRL_NUMBER_OID, extension(CRL_NUMBER_OID, new asn1.Integer({ value: -1 }))),
      /Invalid CRL Number/,
    ],
    ["CRL Number with a trailing byte", withTrailingByte(CRL_NUMBER_OID), /Invalid CRL Number/],
    [
      "CRL Number one octet over the limit",
      replacing(
        CRL_NUMBER_OID,
        extension(
          CRL_NUMBER_OID,
          asn1.Integer.fromBigInt(2n ** BigInt(8 * MAX_CRL_NUMBER_OCTETS - 1))
        )
      ),
      /Invalid CRL Number/,
    ],
    [
      "Delta CRL Indicator with a trailing byte",
      replacing(DELTA_INDICATOR_OID, rawExtension(DELTA_INDICATOR_OID, [0x02, 0x01, 0x01, 0x00])),
      /Invalid Delta CRL Indicator/,
    ],
    ["AKI with a trailing byte", withTrailingByte(AKI_OID), /Invalid Authority Key Identifier/],
    [
      "Delta CRL Indicator NULL",
      replacing(DELTA_INDICATOR_OID, extension(DELTA_INDICATOR_OID, new asn1.Null())),
      /Invalid Delta CRL Indicator/,
    ],
    [
      "AKI NULL",
      replacing(AKI_OID, extension(AKI_OID, new asn1.Null())),
      /Invalid Authority Key Identifier/,
    ],
  ])(
    "rejects a CRL with %s as invalid_crl / extension_value without writing",
    async (_, edit, detail) => {
      const { base } = await fresh();
      const store = recordingStore(base);
      const { result, record } = await publish(store, reencoded(edit));
      expect(result).toEqual({ error: "invalid_crl", details: { reason: "extension_value" } });
      expect(record.detail).toMatch(detail);
      expect(store.writes).toEqual([]);
    }
  );

  // The control: PKIjs re-encodes the unedited CRL byte for byte, so each case above differs from
  // a validly signed CRL only in the replaced extension.
  it("re-encodes the unedited full-01 to the fixture's bytes (control)", () => {
    expect(reencoded((extensions) => extensions)).toEqual(fixture(FULL_01));
  });
});

// The outer signatureAlgorithm is outside the signature. asn1js decodes an OID subidentifier padded
// with 0x80 and a NULL with contents and re-encodes both canonically, so unless the octets are
// compared as received a third party could make such a variant of a genuine CRL current first (no
// upload token by default), one OpenSSL cannot load, and lock the CA's own bytes out as conflict.
describe("publishCrl: a rewritten outer signatureAlgorithm", () => {
  it.each([
    [FULL_01, "an OID padded with 0x80", padOid],
    [FULL_01, "a NULL with contents", nullWithContents],
    [ROOT_FULL_01, "an OID padded with 0x80", padOid],
    [ROOT_FULL_01, "an added NULL with contents", nullWithContents],
  ])("rejects %s with %s as invalid_crl, then takes the genuine file", async (file, _, rewrite) => {
    const { base } = await fresh();
    const store = recordingStore(base);
    const variant = withOuterAlgorithm(fixture(file), rewrite);
    expect(variant).not.toEqual(fixture(file));
    expect((await publish(store, variant)).result).toEqual({
      error: "invalid_crl",
      details: { reason: "signature_algorithm_mismatch" },
    });
    expect(store.writes).toEqual([]);
    expect((await publishFile(store, file)).result).toMatchObject({ outcome: "created" });
  });
});

describe("publishCrl: the signature before the freshness (step 6 before step 7)", () => {
  // Only the Worker smoke's upload order pinned this before (slice 4 review, tests C8).
  it("answers invalid_signature, not stale_crl, for a broken CRL older than the current one", async () => {
    const { base } = await fresh();
    const broken = "crls/issuing-ca-1/full-broken-sig.der";
    const newer = "crls/issuing-ca-1/full-pss.der";
    expect(BigInt(crlEntry(newer).crlNumber!)).toBeGreaterThan(BigInt(crlEntry(broken).crlNumber!));
    expect((await publishFile(base, newer)).result).toMatchObject({ outcome: "created" });
    const store = recordingStore(base);
    const algorithm = parseCRL(fixture(broken)).signatureAlgorithm.algorithmId;
    expect((await publishFile(store, broken)).result).toEqual({
      error: "invalid_signature",
      details: { algorithm: SIGNATURE_ALG_NAMES[algorithm] },
    });
    expect(store.writes).toEqual([]);
  });

  // Unverified revoked entries are never decoded: an anonymous upload costs one signature check.
  it("answers invalid_signature, not invalid_crl, for a revoked list of 50 000 NULLs", async () => {
    const { base } = await fresh();
    const crl = parseCRL(fixture(FULL_01));
    const schema = crl.toSchema(true) as asn1.Sequence;
    const fields = (schema.valueBlock.value[0] as asn1.Sequence).valueBlock.value;
    const revoked = fields.findIndex(
      (field, index) => field instanceof asn1.Sequence && fields[index - 1] instanceof asn1.UTCTime
    );
    fields[revoked] = new asn1.Sequence({
      value: Array.from({ length: 50_000 }, () => new asn1.Null()),
    });
    const junk = new Uint8Array(schema.toBER(false));
    expect(await pkiError(() => parseCRL(junk))).toEqual({ kind: "crl", reason: "structure" });
    const store = recordingStore(base);
    expect((await publish(store, junk)).result).toEqual({
      error: "invalid_signature",
      details: { algorithm: SIGNATURE_ALG_NAMES[crl.signatureAlgorithm.algorithmId] },
    });
    expect(store.writes).toEqual([]);
  });
});

describe("publishCrl: issuer and target (M3, M4, M23, C5)", () => {
  it("answers missing_aki without an AKI (full-no-aki) or without its keyIdentifier", async () => {
    const { base } = await fresh();
    const store = recordingStore(base);
    const missing = { error: "issuer_not_found", details: { reason: "missing_aki" } };
    expect((await publishFile(store, "crls/issuing-ca-1/full-no-aki.der")).result).toEqual(missing);
    const withoutKeyId = reencoded(replacing(AKI_OID, extension(AKI_OID, new asn1.Sequence())));
    expect((await publish(store, withoutKeyId)).result).toEqual(missing);
    expect(store.writes).toEqual([]);
  });

  it("answers issuer_not_found with the AKI when no imported certificate has it (rogue-ca)", async () => {
    const { base } = await fresh();
    const rogue = fixture(cert("rogue-ca").der);
    const { subjectKeyId } = await buildCertificateSummary(parseCertificate(rogue), rogue);
    const store = recordingStore(base);
    expect((await publishFile(store, "crls/rogue-ca/full-01.der")).result).toEqual({
      error: "issuer_not_found",
      details: { authorityKeyId: subjectKeyId },
    });
    expect(store.writes).toEqual([]);
  });

  it("publishes a delta to the delta target and leaves the full target alone", async () => {
    const { base, setup } = await fresh();
    const full = setup.target("issuing-ca-1", "full");
    const delta = setup.target("issuing-ca-1", "delta");
    await publishFile(base, FULL_01);
    const { result } = await publishFile(base, DELTA_01);
    expect(result).toMatchObject({ outcome: "created", targetId: delta, kind: "delta" });
    expect(await currentOf(base, delta)).toEqual(await currentCrl(DELTA_01, delta));
    expect(await currentOf(base, full)).toEqual(await currentCrl(FULL_01, full));
    expect(await keys(base, `history/`)).toEqual([]);
  });

  it("answers target_not_configured for a delta when the issuer only has a full target", async () => {
    const { base } = await fresh({ targets: [{ issuer: "issuing-ca-1", kind: "full" }] });
    const store = recordingStore(base);
    expect((await publishFile(store, DELTA_01)).result).toEqual({
      error: "target_not_configured",
      details: { kind: "delta", certificates: [cert("issuing-ca-1").sha256] },
    });
    expect(store.writes).toEqual([]);
  });

  it("answers target_not_configured for an imported certificate no target names", async () => {
    const { base } = await fresh({
      targets: [
        { issuer: "issuing-ca-1", kind: "full" },
        { issuer: "issuing-ca-1", kind: "delta" },
      ],
    });
    const store = recordingStore(base);
    expect((await publishFile(store, "crls/issuing-ca-2/full-01.der")).result).toEqual({
      error: "target_not_configured",
      details: { kind: "full", certificates: [cert("issuing-ca-2").sha256] },
    });
    expect(store.writes).toEqual([]);
  });

  it("answers target_not_configured before any config.json is applied", async () => {
    const base = new MemoryStore();
    await importCertificate({ store: base, now: () => NOW }, fixture(cert("issuing-ca-1").der));
    const store = recordingStore(base);
    expect((await publishFile(store, FULL_01)).result).toEqual({
      error: "target_not_configured",
      details: { kind: "full", certificates: [cert("issuing-ca-1").sha256] },
    });
    expect(store.writes).toEqual([]);
  });

  // The issuer the target names verifies; another certificate with the same SKI changes nothing.
  it("verifies with issuing-ca-1 while the same-key renewal is imported but unbound", async () => {
    const { base, setup } = await fresh({
      certificates: [...IMPORTED, "issuing-ca-1-renewed"],
    });
    const targetId = setup.target("issuing-ca-1", "full");
    const { result } = await publishFile(base, FULL_01);
    expect(result).toMatchObject({ outcome: "created", issuer: cert("issuing-ca-1").sha256 });
    expect((await currentOf(base, targetId))!.verifier).toBe(cert("issuing-ca-1").sha256);
  });

  it("verifies with the renewal where the renewal's target is the one of that kind", async () => {
    const { base, setup } = await fresh({
      certificates: ["root-ca", "issuing-ca-1", "issuing-ca-1-renewed"],
      targets: [
        { issuer: "issuing-ca-1", kind: "full" },
        { issuer: "issuing-ca-1-renewed", kind: "delta" },
      ],
    });
    const renewed = cert("issuing-ca-1-renewed").sha256;
    const delta = setup.target("issuing-ca-1-renewed", "delta");
    expect((await publishFile(base, DELTA_01)).result).toMatchObject({
      outcome: "created",
      targetId: delta,
      issuer: renewed,
      current: { verifier: renewed },
    });
    expect((await publishFile(base, FULL_01)).result).toMatchObject({
      outcome: "created",
      issuer: cert("issuing-ca-1").sha256,
    });
  });

  it("throws (500) on a config.json that breaks V6 out of band, without writing", async () => {
    const { base, setup } = await fresh({
      certificates: [...IMPORTED, "issuing-ca-1-renewed"],
    });
    const withRenewal = {
      ...setup.config,
      targets: {
        ...setup.config.targets,
        [crypto.randomUUID()]: {
          issuer: cert("issuing-ca-1-renewed").sha256,
          kind: "full" as const,
          label: "renewed",
        },
      },
    };
    // applyConfig never stores it: a second full target for the same SKI breaks V6.
    const stored = await base.get(CONFIG_KEY);
    expect(
      await applyConfig({ store: base }, withRenewal, {
        ifMatch: await sha256Hex(stored!.bytes),
      })
    ).toMatchObject({ error: "config_invalid", details: { issues: [{ rule: "V6" }] } });

    const broken = ConfigSchema.parse(withRenewal);
    await putConfig(base, broken);
    const store = recordingStore(base);
    const records: PublishLogRecord[] = [];
    await expect(
      publishCrl({ store, now: () => NOW, log: (record) => records.push(record) }, fixture(FULL_01))
    ).rejects.toThrow(/V6/);
    expect(records).toMatchObject([{ level: "error", reason: "internal", attempts: 1 }]);
    expect(store.writes).toEqual([]);
  });

  it("re-resolves the target after a lost race and verifies with its new issuer", async () => {
    const { base, setup } = await fresh({
      certificates: ["root-ca", "issuing-ca-1", "issuing-ca-1-renewed"],
      targets: [{ issuer: "issuing-ca-1", kind: "full" }],
    });
    const first = setup.target("issuing-ca-1", "full");
    const second = crypto.randomUUID();
    const renewed = cert("issuing-ca-1-renewed").sha256;
    // Between this call's state read and its catalog write: the operator replaces the target by
    // one of the renewal (another import changes the catalog, so the catalog write is lost).
    const rival = async () => {
      const stored = await base.get(CONFIG_KEY);
      const applied = await applyConfig(
        { store: base },
        {
          version: 1,
          certificates: {},
          targets: { [second]: { issuer: renewed, kind: "full", label: "renewed" } },
          paths: { "/crl/renewed.crl": { target: second } },
        },
        { ifMatch: await sha256Hex(stored!.bytes) }
      );
      expect(applied).not.toHaveProperty("error");
      await importCertificate({ store: base, now: () => NOW }, fixture(cert("issuing-ca-2").der));
    };
    const verify = vi.spyOn(engine, "verifyWithPublicKey");
    const run = await publishFile(racingStore(base, rival), FULL_01);
    // Step 6.6: the retry resolved another issuer, so it verified again (same key, other id).
    expect(verify).toHaveBeenCalledTimes(2);
    expect(run.result).toEqual({
      outcome: "created",
      targetId: second,
      kind: "full",
      issuer: renewed,
      current: { ...(await currentCrl(FULL_01, second)), verifier: renewed },
      downloads: ["/crl/renewed.crl", "/crl/renewed.crl.pem"],
    });
    expect(run.sleeps).toEqual([250]);
    // The blob written for the first target is an orphan: no catalog entry, no marker.
    expect((await storedCatalog(base)).targets).toEqual({
      [second]: { current: { ...(await currentCrl(FULL_01, second)), verifier: renewed } },
    });
    expect(await keys(base, `blobs/crls/${first}/`)).toEqual([
      (await currentCrl(FULL_01, first)).key,
    ]);
    expect(await keys(base, "history/")).toEqual([]);
  });

  it("fails with 500 when the issuer's blob is missing, writing nothing", async () => {
    const { base } = await fresh();
    const blob = certificateBlobKey(cert("issuing-ca-1").sha256);
    await base.delete(blob);
    const store = recordingStore(base);
    const records: PublishLogRecord[] = [];
    await expect(
      publishCrl({ store, now: () => NOW, log: (record) => records.push(record) }, fixture(FULL_01))
    ).rejects.toThrow(/missing/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      msg: "publish",
      reason: "internal",
      kind: "full",
      sha256: crlEntry(FULL_01).sha256,
      attempts: 1,
      detail: expect.stringContaining(blob) as unknown,
    });
    expect(store.writes).toEqual([]);
  });
});

describe("publishCrl: what an upload writes", () => {
  it("writes the blob create-only, then the catalog; current carries key, verifier and now", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    const store = recordingStore(base);
    const der = fixture(FULL_01);
    const sha256 = crlEntry(FULL_01).sha256;
    const summary = await buildCrlSummary(parseCRL(der), der);
    const key = crlBlobKey(targetId, summary, sha256);
    expect(key).toBe(`blobs/crls/${targetId}/${crlVersionName(summary, sha256)}.der`);

    const { result } = await publishFile(store, FULL_01);
    expect(puts(store)).toEqual([
      { key, opts: { ifNoneMatch: "*", contentType: "application/pkix-crl" }, ok: true },
      {
        key: CATALOG_KEY,
        opts: { contentType: "application/json", ifMatch: expect.any(String) as unknown },
        ok: true,
      },
    ]);
    expect((await base.get(key))!.bytes).toEqual(der);
    const current = await currentOf(base, targetId);
    expect(current).toEqual({
      sha256,
      key,
      size: der.byteLength,
      publishedAt: NOW.toISOString(),
      verifier: cert("issuing-ca-1").sha256,
      summary,
    });
    expect(result).toMatchObject({
      current,
      downloads: [
        ISSUING_FULL_ALIAS,
        `${ISSUING_FULL_ALIAS}.pem`,
        "/crl/issuing-ca-1.crl",
        "/crl/issuing-ca-1.crl.pem",
      ],
    });
  });

  it.each(["crls/issuing-ca-1/full-01.pem", "crls/issuing-ca-1/full-01.crlf.pem"])(
    "answers %s after full-01.der with unchanged and no write",
    async (pem) => {
      const { base, setup } = await fresh();
      await publishFile(base, FULL_01);
      const store = recordingStore(base);
      expect((await publishFile(store, pem)).result).toMatchObject({
        outcome: "unchanged",
        current: await currentCrl(FULL_01, setup.target("issuing-ca-1", "full")),
      });
      expect(store.writes).toEqual([]);
    }
  );

  it("records the superseded current as a history marker named like its blob (C8)", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    await publishFile(base, FULL_01);
    const store = recordingStore(base);
    const { result } = await publishFile(store, FULL_02);
    const first = await currentCrl(FULL_01, targetId);
    const second = await currentCrl(FULL_02, targetId);
    const marker = crlHistoryKey(targetId, first.summary, first.sha256);
    expect(result).toMatchObject({ outcome: "updated", current: second });

    expect(puts(store)).toEqual([
      {
        key: second.key,
        opts: { ifNoneMatch: "*", contentType: "application/pkix-crl" },
        ok: true,
      },
      { key: marker, opts: { ifNoneMatch: "*", contentType: "application/json" }, ok: true },
      {
        key: CATALOG_KEY,
        opts: { contentType: "application/json", ifMatch: expect.any(String) as unknown },
        ok: true,
      },
    ]);
    // History = markers ∪ current (plan §5.3): { full-01 marker, full-02 current }.
    expect(await keys(base, `history/${targetId}/`)).toEqual([marker]);
    // The superseded record verbatim, without a time of its own (slice 4 review C6).
    expect(await json(base, marker)).toEqual(first);
    expect(await currentOf(base, targetId)).toEqual(second);
    // Blob and marker share the version name, so a list of both prefixes pairs them.
    const name = crlVersionName(first.summary, first.sha256);
    expect(first.key).toBe(`blobs/crls/${targetId}/${name}.der`);
    expect(marker).toBe(`history/${targetId}/${name}.json`);
    expect(await keys(base, `blobs/crls/${targetId}/`)).toEqual([first.key, second.key]);
  });

  it("replaces the summary whole (slice 2 summary case 2)", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    await publishFile(base, FULL_01);
    await publishFile(base, FULL_02);
    const der = fixture(FULL_02);
    const expected = await buildCrlSummary(parseCRL(der), der);
    const { summary } = (await currentOf(base, targetId))!;
    expect(summary).toStrictEqual(expected);
    expect(Object.keys(summary).sort()).toEqual(Object.keys(CrlSummarySchema.shape).sort());
  });

  it("publishes the AD CS shapes (D7) with their Next CRL Publish", async () => {
    const { base, setup } = await fresh();
    for (const file of ["crls/issuing-ca-1/full-adcs.der", "crls/issuing-ca-1/delta-adcs.der"]) {
      const entry = crlEntry(file);
      const targetId = setup.target(entry.issuer, entry.kind);
      expect((await publishFile(base, file)).result).toMatchObject({
        outcome: "created",
        targetId,
      });
      expect((await currentOf(base, targetId))!.summary.nextPublish).toBe(
        new Date(entry.nextPublish!).toISOString()
      );
    }
  });
});

describe("publishCrl: concurrent writers (plan §5.5)", () => {
  // The rival publishes on the store underneath, between this call's state read and its catalog
  // write. full-02 is uploaded; the rival's CRL is older, the same or newer.
  it.each([
    ["an older CRL", "updated", FULL_01],
    ["the same CRL", "unchanged", FULL_02],
    ["a newer CRL", "stale_crl", FULL_03],
  ] as const)("re-reads after a rival published %s → %s", async (_, outcome, rivalFile) => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    const verify = vi.spyOn(engine, "verifyWithPublicKey");
    let rivalVerifications = 0;
    const store = recordingStore(
      racingStore(base, async () => {
        const before = verify.mock.calls.length;
        await publishFile(base, rivalFile);
        rivalVerifications = verify.mock.calls.length - before;
      })
    );
    const run = await publishFile(store, FULL_02);
    const ours = await currentCrl(FULL_02, targetId);
    const rival = await currentCrl(rivalFile, targetId);

    expect(run.sleeps).toEqual([250]);
    expect(run.record.attempts).toBe(2);
    // Step 6.6: the retry resolved the same issuer and reused the first attempt's check.
    expect(rivalVerifications).toBe(1);
    expect(verify.mock.calls.length - rivalVerifications).toBe(1);
    expect(await base.get(ours.key)).not.toBeNull();
    const written = puts(store).map((put) => [put.key, put.ok]);
    switch (outcome) {
      case "updated": {
        expect(run.result).toMatchObject({ outcome, current: ours });
        expect(await currentOf(base, targetId)).toEqual(ours);
        const marker = crlHistoryKey(targetId, rival.summary, rival.sha256);
        expect(await keys(base, "history/")).toEqual([marker]);
        expect(written).toEqual([
          [ours.key, true],
          [CATALOG_KEY, false],
          [marker, true],
          [CATALOG_KEY, true],
        ]);
        break;
      }
      case "unchanged":
        expect(run.result).toMatchObject({ outcome, current: rival });
        expect(await keys(base, "history/")).toEqual([]);
        expect(written).toEqual([
          [ours.key, true],
          [CATALOG_KEY, false],
        ]);
        break;
      case "stale_crl":
        expect(run.result).toEqual({ error: outcome, details: { current: versionOf(rivalFile) } });
        expect(await currentOf(base, targetId)).toEqual(rival);
        // Our blob stays as an orphan: not current, no marker, so not history (C8).
        expect(await keys(base, `blobs/crls/${targetId}/`)).toEqual([ours.key, rival.key].sort());
        expect(await keys(base, "history/")).toEqual([]);
        expect(written).toEqual([
          [ours.key, true],
          [CATALOG_KEY, false],
        ]);
        break;
    }
  });

  it("gives up after 4 lost catalog writes with concurrent_update", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    await publishFile(base, FULL_01);
    const before = await base.get(CATALOG_KEY);
    const store = recordingStore(flakyStore(base, { failIfMatch: 4 }));
    const run = await publishFile(store, FULL_02);
    expect(run.result).toEqual({ error: "concurrent_update" });
    expect(run.sleeps).toEqual([250, 500, 1000]);
    expect(run.record).toMatchObject({ level: "warn", reason: "concurrent_update", attempts: 4 });

    const first = await currentCrl(FULL_01, targetId);
    const second = await currentCrl(FULL_02, targetId);
    const marker = crlHistoryKey(targetId, first.summary, first.sha256);
    // Blob and marker once each (create-only, immutable), then 1 + 3 conditional catalog writes.
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [second.key, true],
      [marker, true],
      ...Array.from({ length: 4 }, () => [CATALOG_KEY, false]),
    ]);
    expect(
      puts(store)
        .filter((put) => put.key === CATALOG_KEY)
        .every((put) => put.opts.ifMatch !== undefined)
    ).toBe(true);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(before!.bytes);
    // Left behind: the orphan blob, and the marker of full-01, which stays current (a history
    // listing pairs them by name, plan §5.3). The marker holds no time: whenever full-01 is really
    // superseded, its existing marker is still right (slice 4 review C6).
    expect(await base.get(second.key)).not.toBeNull();
    expect(await currentOf(base, targetId)).toEqual(first);
    expect(await json(base, marker)).toEqual(first);
  });
});

describe("publishCrl: the publish log line (plan §4.3)", () => {
  it("logs every field of a success", async () => {
    const { base, setup } = await fresh();
    const entry = crlEntry(FULL_01);
    const { record } = await publishFile(base, FULL_01);
    expect(record).toEqual({
      level: "info",
      msg: "publish",
      targetId: setup.target("issuing-ca-1", "full"),
      kind: "full",
      outcome: "created",
      sha256: entry.sha256,
      crlNumber: entry.crlNumber,
      thisUpdate: new Date(entry.thisUpdate).toISOString(),
      expired: false,
      attempts: 1,
      ms: expect.any(Number) as unknown,
    });
    expect(record.ms).toBeGreaterThanOrEqual(0);
  });

  it("logs expired for a CRL past its nextUpdate (delta-01 at NOW), and unchanged", async () => {
    const { base } = await fresh();
    expect((await publishFile(base, DELTA_01)).record).toMatchObject({
      outcome: "created",
      kind: "delta",
      expired: true,
    });
    // Bytes already current are not parsed again: their kind and number come from the catalog.
    expect((await publishFile(base, DELTA_01)).record).toMatchObject({
      level: "info",
      outcome: "unchanged",
      kind: "delta",
      attempts: 1,
    });
  });

  it("logs the reason and what was known of a rejection", async () => {
    const { base, setup } = await fresh();
    const entry = crlEntry("crls/issuing-ca-1/full-unknown-critical.der");
    // The policy runs before the target is resolved: no targetId.
    expect((await publishFile(base, entry.file)).record).toEqual({
      level: "warn",
      msg: "publish",
      kind: "full",
      reason: "unknown_critical_extension",
      sha256: entry.sha256,
      crlNumber: entry.crlNumber,
      thisUpdate: new Date(entry.thisUpdate).toISOString(),
      attempts: 1,
      ms: expect.any(Number) as unknown,
      detail: expect.stringContaining("1.3.6.1.4.1.32473.1") as unknown,
    });
    // A 409 knows the target.
    await publishFile(base, FULL_02);
    expect((await publishFile(base, FULL_01)).record).toMatchObject({
      level: "warn",
      reason: "stale_crl",
      targetId: setup.target("issuing-ca-1", "full"),
      expired: false,
      attempts: 1,
      detail: expect.any(String) as unknown,
    });
    // Bytes that are not a CRL: only their digest.
    const garbage = fixture("invalid/garbage.txt");
    expect((await publish(base, garbage)).record).toEqual({
      level: "warn",
      msg: "publish",
      reason: "invalid_crl",
      sha256: await sha256Hex(garbage),
      attempts: 1,
      ms: expect.any(Number) as unknown,
      detail: expect.stringMatching(/^der: /) as unknown,
    });
  });

  // C7 of the slice 4 review: a field the call does not know at its end is left out, also when an
  // earlier attempt knew it.
  it("logs no targetId when the retry no longer finds the target", async () => {
    const { base } = await fresh({
      certificates: ["root-ca", "issuing-ca-1"],
      targets: [{ issuer: "issuing-ca-1", kind: "full" }],
    });
    // Between this call's state read and its catalog write: the operator removes every target,
    // and an import changes the catalog, so the catalog write is lost.
    const rival = async () => {
      const stored = await base.get(CONFIG_KEY);
      const applied = await applyConfig(
        { store: base },
        { version: 1, certificates: {}, targets: {}, paths: {} },
        { ifMatch: await sha256Hex(stored!.bytes) }
      );
      expect(applied).not.toHaveProperty("error");
      await importCertificate({ store: base, now: () => NOW }, fixture(cert("issuing-ca-2").der));
    };
    const entry = crlEntry(FULL_01);
    const run = await publishFile(racingStore(base, rival), FULL_01);
    expect(run.result).toEqual({
      error: "target_not_configured",
      details: { kind: "full", certificates: [cert("issuing-ca-1").sha256] },
    });
    expect(run.record).toEqual({
      level: "warn",
      msg: "publish",
      kind: "full",
      reason: "target_not_configured",
      sha256: entry.sha256,
      crlNumber: entry.crlNumber,
      thisUpdate: new Date(entry.thisUpdate).toISOString(),
      expired: false,
      attempts: 2,
      ms: expect.any(Number) as unknown,
      detail: expect.stringMatching(/^No full target names certificate /) as unknown,
    });
  });
});

// CRLs a CA made in the test signs (tests/helpers/generated-ca.ts): shapes the fixtures cannot hold.
describe("publishCrl: CRLs of a generated CA", () => {
  const ca = generateCa();

  // C1 of the slice 4 review: asn1js 3.1.0 limits a decoding to 10 000 nodes by default, and an
  // entry with a reasonCode takes 8, so about 1 250 such entries made a valid CRL invalid_crl / der.
  it("publishes a CRL with 3000 revoked entries, each with a reasonCode", async () => {
    const base = new MemoryStore();
    const targetId = await setupGeneratedCa(base, await ca);
    const der = await signCrl(await ca, { revoked: 3000 });
    const { result } = await publish(base, der);
    expect(result).toMatchObject({
      outcome: "created",
      targetId,
      current: { size: der.byteLength, summary: { revokedCount: 3000 } },
    });
  });

  // C5: the number is part of the blob and marker names, and a file system allows 255 octets,
  // also for the fs adapter's temporary file `.<name>.<uuid>.tmp` (tests/storage writes one).
  it("publishes a CRL Number of MAX_CRL_NUMBER_OCTETS octets and refuses one more", async () => {
    const base = new MemoryStore();
    const targetId = await setupGeneratedCa(base, await ca);
    const largest = 2n ** BigInt(8 * MAX_CRL_NUMBER_OCTETS - 1) - 1n;
    expect(asn1.Integer.fromBigInt(largest).valueBlock.valueHexView).toHaveLength(
      MAX_CRL_NUMBER_OCTETS
    );
    const over = await signCrl(await ca, { crlNumber: largest + 1n });
    const store = recordingStore(base);
    const refused = await publish(store, over);
    expect(refused.result).toEqual({
      error: "invalid_crl",
      details: { reason: "extension_value" },
    });
    expect(refused.record.detail).toMatch(/Invalid CRL Number/);
    expect(store.writes).toEqual([]);

    const { result } = await publish(base, await signCrl(await ca, { crlNumber: largest }));
    expect(result).toMatchObject({
      outcome: "created",
      targetId,
      current: { summary: { crlNumber: largest.toString() } },
    });
    const { current } = result as { current: CurrentCrl };
    const name = crlVersionName(current.summary, current.sha256);
    expect(`.${name}.json.${crypto.randomUUID()}.tmp`.length).toBeLessThanOrEqual(255);
  });
});
