import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import { describe, expect, it } from "vitest";
import { getAuthorityKeyIdHex, parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import { buildCertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import type { CertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { fixture, manifest } from "../fixtures/pki.ts";
import type { ManifestCertificate } from "../fixtures/pki.ts";
import { extension, pkiError } from "../helpers/pki.ts";

// buildCertificateSummary (slice 2 step 3, formats of step 4): case 1 of
// worker-aia-cdp@5b570aa:tests/worker/r2-summary.test.ts, on every fixture certificate. Case 2
// (the CRL summary is replaced whole) is appended here by slice 4.

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

  // M5: the old code skipped a malformed SKI / AKI silently.
  it.each([
    ["a malformed SKI", SKI, new asn1.Null()],
    ["a malformed AKI", AKI, new asn1.Null()],
    ["an empty SKI", SKI, new asn1.OctetString({ valueHex: new ArrayBuffer(0) })],
  ])("rejects %s as extension_value", async (_case, oid, value) => {
    const der = fixture(entry("issuing-ca-1").der);
    const cert = parseCertificate(der);
    cert.extensions = [
      ...(cert.extensions ?? []).filter((ext) => ext.extnID !== oid),
      extension(oid, value),
    ];
    expect(await pkiError(() => buildCertificateSummary(cert, der))).toEqual({
      kind: "certificate",
      reason: "extension_value",
    });
  });
});
