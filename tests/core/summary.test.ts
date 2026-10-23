import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { CrlSummarySchema } from "../../src/core/catalog.ts";
import { MAX_CRL_NUMBER_OCTETS } from "../../src/core/pki/extensions.ts";
import {
  getAuthorityKeyIdHex,
  NEXT_CRL_PUBLISH_OID,
  parseCertificate,
  parseCRL,
} from "../../src/core/pki/parsers.ts";
import {
  buildCertificateSummary,
  buildCrlSummary,
} from "../../src/core/summary/catalog-summary.ts";
import type { CertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { fixture, manifest } from "../fixtures/pki.ts";
import type { ManifestCertificate, ManifestCrl } from "../fixtures/pki.ts";
import { extension, pkiError } from "../helpers/pki.ts";

// buildCertificateSummary (slice 2 step 3, formats of step 4): case 1 of
// worker-aia-cdp@5b570aa:tests/worker/r2-summary.test.ts, on every fixture certificate.
// buildCrlSummary (slice 4 step 2) on every parsable fixture CRL. Case 2 of that file (the CRL
// summary is replaced whole) is a publishCrl test (slice 4 step 6).

const SKI = "2.5.29.14";
const AKI = "2.5.29.35";
const KEY_ID = /^(?:[0-9a-f]{2})+$/;

function entry(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest entry for ${name}`);
  }
  return found;
}

async function summaryOf(name: string): Promise<CertificateSummary> {
  const der = fixture(entry(name).der);
  return buildCertificateSummary(parseCertificate(der), der);
}

describe("buildCertificateSummary", () => {
  it.each(manifest.certificates.map((c) => [c.name, c] as const))(
    "summarizes certs/%s.der in the catalog format",
    async (name, cert) => {
      const der = fixture(cert.der);
      const summary = await summaryOf(name);
      expect(Object.keys(summary).sort()).toEqual(
        [
          "authorityKeyId",
          "issuerCN",
          "notAfter",
          "notBefore",
          "serialNumber",
          "sha1",
          "subjectCN",
          "subjectKeyId",
        ].sort()
      );
      // Uppercase hex of the INTEGER content bytes, as `openssl x509 -serial` prints it.
      expect(summary.serialNumber).toBe(cert.serial);
      expect(summary.serialNumber).toMatch(/^(?:[0-9A-F]{2})+$/);
      expect(Date.parse(summary.notBefore)).toBe(Date.parse(cert.notBefore));
      expect(Date.parse(summary.notAfter)).toBe(Date.parse(cert.notAfter));
      expect(summary.notBefore).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(summary.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(summary.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(summary.sha1).toBe(createHash("sha1").update(der).digest("hex"));
      for (const keyId of [summary.subjectKeyId, summary.authorityKeyId]) {
        expect(keyId === null || KEY_ID.test(keyId), String(keyId)).toBe(true);
      }
      // The issuer side matches the issuing certificate's subject side.
      const issuer = await summaryOf(cert.issuer);
      expect(summary.issuerCN).toEqual(expect.any(String));
      expect(summary.issuerCN).toBe(issuer.subjectCN);
      if (summary.authorityKeyId !== null) {
        expect(summary.authorityKeyId).toBe(issuer.subjectKeyId);
      }
    }
  );

  it("uses null where the key identifiers are absent", async () => {
    expect((await summaryOf("root-ca")).authorityKeyId).toBeNull();
    expect(await summaryOf("leaf-min")).toMatchObject({
      subjectKeyId: null,
      authorityKeyId: null,
    });
  });

  // M4: slice 4 finds a CRL's issuer by comparing the CRL's AKI with catalog subjectKeyIds as
  // strings. Both sides must come out in the same form.
  it("locks subjectKeyId to the AKI that slice 4 reads from the issuer's CRLs", async () => {
    const crl = parseCRL(fixture("crls/issuing-ca-1/full-01.der"));
    const aki = getAuthorityKeyIdHex(crl.crlExtensions?.extensions);
    expect(aki).toEqual(expect.any(String));
    expect((await summaryOf("issuing-ca-1")).subjectKeyId).toBe(aki);
  });

  it("gives the same-key renewal the same subjectKeyId (V6 fixture)", async () => {
    expect((await summaryOf("issuing-ca-1-renewed")).subjectKeyId).toBe(
      (await summaryOf("issuing-ca-1")).subjectKeyId
    );
  });

  it("keeps a leading 00 of the serial number", async () => {
    const der = fixture(entry("leaf-full").der);
    const cert = parseCertificate(der);
    cert.serialNumber = new asn1.Integer({ valueHex: Uint8Array.of(0x00, 0x80, 0x0a).buffer });
    expect((await buildCertificateSummary(cert, der)).serialNumber).toBe("00800A");
  });

  it("uses null for a missing CN", async () => {
    const der = fixture(entry("leaf-full").der);
    const cert = parseCertificate(der);
    cert.subject.typesAndValues = cert.subject.typesAndValues.filter(
      (attribute) => attribute.type !== "2.5.4.3"
    );
    expect((await buildCertificateSummary(cert, der)).subjectCN).toBeNull();
  });

  /** An extension `oid` of issuing-ca-1 with one octet after its value (slice 4 review C3). */
  function withTrailingByte(oid: string) {
    const der = fixture(entry("issuing-ca-1").der);
    const cert = parseCertificate(der);
    const found = cert.extensions?.find((ext) => ext.extnID === oid);
    if (!found) {
      throw new Error(`issuing-ca-1 has no ${oid}`);
    }
    const bytes = Uint8Array.from([...found.extnValue.valueBlock.valueHexView, 0]);
    return new pkijs.Extension({ extnID: oid, extnValue: bytes.buffer });
  }

  // M5: the old code skipped a malformed SKI / AKI silently. Slice 4 review C3: the SKI and AKI
  // are exactly one value, as a CRL's AKI is (getAuthorityKeyIdHex serves both).
  it.each([
    ["a malformed SKI", SKI, () => extension(SKI, new asn1.Null())],
    ["a malformed AKI", AKI, () => extension(AKI, new asn1.Null())],
    [
      "an empty SKI",
      SKI,
      () => extension(SKI, new asn1.OctetString({ valueHex: new ArrayBuffer(0) })),
    ],
    ["an SKI with a trailing byte", SKI, () => withTrailingByte(SKI)],
    ["an AKI with a trailing byte", AKI, () => withTrailingByte(AKI)],
  ])("rejects %s as extension_value", async (_case, oid, replacement) => {
    const der = fixture(entry("issuing-ca-1").der);
    const cert = parseCertificate(der);
    cert.extensions = [
      ...(cert.extensions ?? []).filter((ext) => ext.extnID !== oid),
      replacement(),
    ];
    expect(await pkiError(() => buildCertificateSummary(cert, der))).toEqual({
      kind: "certificate",
      reason: "extension_value",
    });
  });
});

describe("buildCrlSummary", () => {
  /** CRL fixtures that parse (full-bad-time is the only invalid_crl one). */
  const parsable = manifest.crls.filter((crl) => crl.expect !== "invalid_crl");
  const iso = (time: string | null) => (time === null ? null : new Date(time).toISOString());

  function crlEntry(file: string): ManifestCrl {
    const found = manifest.crls.find((crl) => crl.file === file);
    if (!found) {
      throw new Error(`no manifest entry for ${file}`);
    }
    return found;
  }

  /** crl with the extension `oid` replaced by `replacement` (appended when it had none). */
  function withExtension(file: string, oid: string, replacement: pkijs.Extension) {
    const der = fixture(file);
    const crl = parseCRL(der);
    const extensions = crl.crlExtensions?.extensions ?? [];
    crl.crlExtensions = new pkijs.Extensions({
      extensions: [...extensions.filter((ext) => ext.extnID !== oid), replacement],
    });
    return { crl, der };
  }

  it.each(parsable.map((crl) => [crl.file, crl] as const))(
    "summarizes %s in the catalog format",
    async (file, crl) => {
      const der = fixture(file);
      const summary = await buildCrlSummary(parseCRL(der), der);
      expect(summary).toEqual({
        crlNumber: crl.crlNumber,
        baseCrlNumber: crl.baseCrlNumber,
        thisUpdate: iso(crl.thisUpdate),
        nextUpdate: iso(crl.nextUpdate),
        revokedCount: crl.revoked,
        sha1: createHash("sha1").update(der).digest("hex"),
        nextPublish: iso(crl.nextPublish),
      });
      // The strict catalog schema takes it as is (no missing or extra keys, canonical formats).
      expect(CrlSummarySchema.parse(summary)).toEqual(summary);
    }
  );

  it("uses null for a missing nextUpdate and a missing Next CRL Publish", async () => {
    const summary = async (file: string) => {
      const der = fixture(file);
      return buildCrlSummary(parseCRL(der), der);
    };
    expect((await summary("crls/issuing-ca-1/full-no-next-update.der")).nextUpdate).toBeNull();
    expect((await summary("crls/issuing-ca-1/full-01.der")).nextPublish).toBeNull();
    const adcs = crlEntry("crls/issuing-ca-1/full-adcs.der");
    expect(adcs.nextPublish).toEqual(expect.any(String));
    expect((await summary(adcs.file)).nextPublish).toBe(iso(adcs.nextPublish));
  });

  it("counts zero revocations when the list is absent", async () => {
    const file = "crls/root-ca/full-01.der";
    expect(crlEntry(file).revoked).toBe(0);
    const der = fixture(file);
    const crl = parseCRL(der);
    expect(crl.revokedCertificates).toBeUndefined();
    expect((await buildCrlSummary(crl, der)).revokedCount).toBe(0);
  });

  it("reads a Next CRL Publish written as a GeneralizedTime", async () => {
    const at = new Date("2050-06-01T12:00:00Z");
    const { crl, der } = withExtension(
      "crls/issuing-ca-1/full-adcs.der",
      NEXT_CRL_PUBLISH_OID,
      extension(NEXT_CRL_PUBLISH_OID, new asn1.GeneralizedTime({ valueDate: at }))
    );
    expect((await buildCrlSummary(crl, der)).nextPublish).toBe(at.toISOString());
  });

  // A value that cannot be read is null, like a missing extension.
  const utcTime = new asn1.UTCTime({ valueDate: new Date("2026-01-10T12:00:00Z") }).toBER(false);
  it.each([
    ["an INTEGER", extension(NEXT_CRL_PUBLISH_OID, new asn1.Integer({ value: 1 }))],
    [
      "a SEQUENCE holding a time",
      extension(
        NEXT_CRL_PUBLISH_OID,
        new asn1.Sequence({
          value: [new asn1.UTCTime({ valueDate: new Date("2026-01-10T12:00:00Z") })],
        })
      ),
    ],
    [
      "a time followed by a byte",
      new pkijs.Extension({
        extnID: NEXT_CRL_PUBLISH_OID,
        extnValue: Uint8Array.from([...new Uint8Array(utcTime), 0]).buffer,
      }),
    ],
  ])("stores null for a Next CRL Publish holding %s", async (_case, replacement) => {
    const { crl, der } = withExtension(
      "crls/issuing-ca-1/full-adcs.der",
      NEXT_CRL_PUBLISH_OID,
      replacement
    );
    expect((await buildCrlSummary(crl, der)).nextPublish).toBeNull();
  });

  // Exactly one INTEGER ≥ 0 (tag 2, not empty), read as BigInt, up to MAX_CRL_NUMBER_OCTETS.
  it.each([
    ["CRL Number", "2.5.29.20", "crls/issuing-ca-1/full-01.der"],
    ["Delta CRL Indicator", "2.5.29.27", "crls/issuing-ca-1/delta-01.der"],
  ])(
    "rejects a malformed %s as extension_value and keeps a large one",
    async (_name, oid, file) => {
      const largest = 2n ** BigInt(8 * MAX_CRL_NUMBER_OCTETS - 1) - 1n;
      const one = new asn1.Integer({ value: 1 }).toBER(false);
      for (const replacement of [
        extension(oid, new asn1.Integer({ value: -1 })),
        extension(oid, new asn1.OctetString()),
        extension(oid, asn1.Integer.fromBigInt(largest + 1n)),
        new pkijs.Extension({
          extnID: oid,
          extnValue: Uint8Array.from([...new Uint8Array(one), 0]).buffer,
        }),
      ]) {
        const { crl, der } = withExtension(file, oid, replacement);
        expect(await pkiError(() => buildCrlSummary(crl, der))).toEqual({
          kind: "crl",
          reason: "extension_value",
        });
      }
      for (const large of [2n ** 100n + 123n, largest]) {
        const { crl, der } = withExtension(
          file,
          oid,
          extension(oid, asn1.Integer.fromBigInt(large))
        );
        const summary = await buildCrlSummary(crl, der);
        expect(oid === "2.5.29.20" ? summary.crlNumber : summary.baseCrlNumber).toBe(
          large.toString()
        );
      }
    }
  );
});
