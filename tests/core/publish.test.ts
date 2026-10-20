import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
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
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
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
import { extension } from "../helpers/pki.ts";
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
const AKI_OID = "2.5.29.35";
const CRL_NUMBER_OID = "2.5.29.20";
const DELTA_INDICATOR_OID = "2.5.29.27";

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
        expect(await json(base, crlHistoryKey(targetId, before.summary, before.sha256))).toEqual({
          ...before,
          supersededAt: NOW.toISOString(),
        });
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

  // M2: an INTEGER ≥ 0 (tag 2, not empty) for the CRL Number and the Delta CRL Indicator, a
  // decodable AKI with a non-empty keyIdentifier.
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
    [
      "AKI with an empty keyIdentifier",
      replacing(
        AKI_OID,
        extension(
          AKI_OID,
          new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1.OctetString() }).toSchema()
        )
      ),
      /Empty Authority Key Identifier/,
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

  // Step 7 (owner answer 4): the issuer the target names verifies; another certificate with the
  // same SKI changes nothing, and uploads never answer issuer_mismatch.
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
    const run = await publishFile(racingStore(base, rival), FULL_01);
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
    expect(await json(base, marker)).toEqual({ ...first, supersededAt: NOW.toISOString() });
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
    const store = recordingStore(racingStore(base, () => publishFile(base, rivalFile)));
    const run = await publishFile(store, FULL_02);
    const ours = await currentCrl(FULL_02, targetId);
    const rival = await currentCrl(rivalFile, targetId);

    expect(run.sleeps).toEqual([250]);
    expect(run.record.attempts).toBe(2);
    expect(await base.head(ours.key)).not.toBeNull();
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
    // listing pairs them by name, plan §5.3).
    expect(await base.head(second.key)).not.toBeNull();
    expect(await currentOf(base, targetId)).toEqual(first);
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
    expect((await publishFile(base, DELTA_01)).record).toMatchObject({
      level: "info",
      outcome: "unchanged",
      expired: true,
      attempts: 1,
    });
  });

  it("logs the reason and what was known of a rejection", async () => {
    const { base, setup } = await fresh();
    const entry = crlEntry("crls/issuing-ca-1/full-unknown-critical.der");
    // The policy runs before the target is resolved: no targetId, no attempt.
    expect((await publishFile(base, entry.file)).record).toEqual({
      level: "warn",
      msg: "publish",
      kind: "full",
      reason: "unknown_critical_extension",
      sha256: entry.sha256,
      crlNumber: entry.crlNumber,
      thisUpdate: new Date(entry.thisUpdate).toISOString(),
      attempts: 0,
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
      attempts: 0,
      ms: expect.any(Number) as unknown,
      detail: expect.stringMatching(/^der: /) as unknown,
    });
  });
});
