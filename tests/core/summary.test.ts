import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import { describe, expect, it } from "vitest";
import { CrlSummarySchema } from "../../src/core/catalog.ts";
import { NEXT_CRL_PUBLISH_OID, parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import {
  buildCertificateSummary,
  buildCrlSummary,
} from "../../src/core/summary/catalog-summary.ts";
import type { CertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { cert, fixture, manifest } from "../fixtures/pki.ts";
import { extension, pkiError } from "../helpers/pki.ts";

// The catalog summaries: buildCertificateSummary on every fixture certificate, buildCrlSummary on
// every parsable fixture CRL.

const sha1 = (der: Uint8Array) => createHash("sha1").update(der).digest("hex");
const iso = (time: string | null) => (time === null ? null : new Date(time).toISOString());

async function summaryOf(name: string): Promise<CertificateSummary> {
  const der = fixture(cert(name).der);
  return buildCertificateSummary(parseCertificate(der), der);
}

describe("buildCertificateSummary", () => {
  it.each(manifest.certificates.map((c) => [c.name, c] as const))(
    "summarizes certs/%s.der in the catalog format",
    async (name, entry) => {
      const summary = await summaryOf(name);
      // The issuer side matches the issuing certificate's subject side.
      const issuer = await summaryOf(entry.issuer);
      expect(summary).toEqual({
        // Uppercase hex of the INTEGER content bytes, as `openssl x509 -serial` prints it.
        serialNumber: entry.serial,
        notBefore: iso(entry.notBefore),
        notAfter: iso(entry.notAfter),
        sha1: sha1(fixture(entry.der)),
        subjectCN: expect.any(String) as unknown,
        issuerCN: issuer.subjectCN,
        subjectKeyId:
          summary.subjectKeyId === null
            ? null
            : (expect.stringMatching(/^(?:[0-9a-f]{2})+$/) as unknown),
        authorityKeyId: summary.authorityKeyId === null ? null : issuer.subjectKeyId,
      });
    }
  );

  it("uses null where the key identifiers or the CN are absent", async () => {
    expect((await summaryOf("root-ca")).authorityKeyId).toBeNull();
    expect(await summaryOf("leaf-min")).toMatchObject({ subjectKeyId: null, authorityKeyId: null });
    const der = fixture(cert("leaf-full").der);
    const certificate = parseCertificate(der);
    certificate.subject.typesAndValues = certificate.subject.typesAndValues.filter(
      (attribute) => attribute.type !== "2.5.4.3"
    );
    expect((await buildCertificateSummary(certificate, der)).subjectCN).toBeNull();
  });

  it("keeps a leading 00 of the serial number", async () => {
    const der = fixture(cert("leaf-full").der);
    const certificate = parseCertificate(der);
    certificate.serialNumber = new asn1.Integer({
      valueHex: Uint8Array.of(0x00, 0x80, 0x0a).buffer,
    });
    expect((await buildCertificateSummary(certificate, der)).serialNumber).toBe("00800A");
  });

  it.each(["2.5.29.14", "2.5.29.35"])("rejects a malformed %s as extension_value", async (oid) => {
    const der = fixture(cert("issuing-ca-1").der);
    const certificate = parseCertificate(der);
    certificate.extensions = [
      ...(certificate.extensions ?? []).filter((ext) => ext.extnID !== oid),
      extension(oid, new asn1.Null()),
    ];
    await expect(buildCertificateSummary(certificate, der)).rejects.toThrow(
      pkiError("certificate", "extension_value")
    );
  });
});

describe("buildCrlSummary", () => {
  it.each(
    manifest.crls
      .filter((crl) => crl.expect !== "invalid_crl")
      .map((crl) => [crl.file, crl] as const)
  )("summarizes %s in the catalog format", async (file, crl) => {
    const der = fixture(file);
    const summary = await buildCrlSummary(parseCRL(der), der);
    expect(summary).toEqual({
      crlNumber: crl.crlNumber,
      baseCrlNumber: crl.baseCrlNumber,
      thisUpdate: iso(crl.thisUpdate),
      nextUpdate: iso(crl.nextUpdate),
      revokedCount: crl.revoked,
      sha1: sha1(der),
      nextPublish: iso(crl.nextPublish),
    });
    // The strict catalog schema takes it as is (no missing or extra keys, canonical formats).
    expect(CrlSummarySchema.parse(summary)).toEqual(summary);
  });

  // The time only informs the CRL status: a value that cannot be read is null, not a rejection.
  const time = new asn1.UTCTime({ valueDate: new Date("2026-01-10T12:00:00Z") });
  it.each([
    [
      "a GeneralizedTime",
      new asn1.GeneralizedTime({ valueDate: new Date("2050-06-01T12:00:00Z") }),
      "2050-06-01T12:00:00.000Z",
    ],
    ["an INTEGER", new asn1.Integer({ value: 1 }), null],
    ["a SEQUENCE holding a time", new asn1.Sequence({ value: [time] }), null],
  ])("reads a Next CRL Publish holding %s", async (_case, value, expected) => {
    const der = fixture("crls/issuing-ca-1/full-adcs.der");
    const crl = parseCRL(der);
    crl.crlExtensions!.extensions = [
      ...crl.crlExtensions!.extensions.filter((ext) => ext.extnID !== NEXT_CRL_PUBLISH_OID),
      extension(NEXT_CRL_PUBLISH_OID, value),
    ];
    expect((await buildCrlSummary(crl, der)).nextPublish).toBe(expected);
  });
});
