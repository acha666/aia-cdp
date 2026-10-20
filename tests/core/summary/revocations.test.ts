import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import { buildCrlSummary } from "../../../src/core/summary/catalog-summary.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";

// The CRL detail returns every revoked entry (slice 5a step 3): the v2 builder returned a page of
// 10, and every fixture CRL has at most 2, so these CRLs copy the entries of a fixture CRL to more
// than a page. Re-encoded from the fields with toSchema(true), like
// worker-aia-cdp@5b570aa:tests/worker/extension-parsers.test.ts:647: the signature no longer
// matches, which building the detail does not check.

const SOURCE = "crls/issuing-ca-1/full-03.der";

/** SOURCE with `count` revoked entries: its own in turn, each under serial 1, 2, …, `count`. */
function withEntries(count: number): Uint8Array {
  const crl = parseCRL(fixture(SOURCE));
  const entries = crl.revokedCertificates ?? [];
  crl.revokedCertificates = Array.from({ length: count }, (_, index) => {
    const entry = entries[index % entries.length]!;
    return new pkijs.RevokedCertificate({
      userCertificate: new asn1.Integer({ value: index + 1 }),
      revocationDate: entry.revocationDate,
      crlEntryExtensions: entry.crlEntryExtensions,
    });
  });
  // PKIjs types CertificateRevocationList.toSchema() as any.
  return new Uint8Array((crl.toSchema(true) as asn1.Sequence).toBER(false));
}

describe("buildTBSCertList revokedCertificates", () => {
  it("is { count: 0, items: [] } for a CRL without entries", () => {
    const file = "crls/root-ca/full-01.der";
    expect(manifest.crls.find((crl) => crl.file === file)?.revoked).toBe(0);
    expect(buildTBSCertList(parseCRL(fixture(file))).revokedCertificates).toEqual({
      count: 0,
      items: [],
    });
  });

  it("returns all 11 entries, in order, with their entry extensions", async () => {
    const der = withEntries(11);
    const crl = parseCRL(der);
    const { count, items } = buildTBSCertList(crl).revokedCertificates;
    expect(count).toBe(11);
    expect(items).toHaveLength(count);
    expect(count).toBe((await buildCrlSummary(crl, der)).revokedCount);
    expect(items.map((item) => item.userCertificate.decimal)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1))
    );
    const source = buildTBSCertList(parseCRL(fixture(SOURCE))).revokedCertificates.items;
    for (const [index, item] of items.entries()) {
      const copied = source[index % source.length]!;
      expect(item.revocationDate).toEqual(copied.revocationDate);
      expect(item.crlEntryExtensions).toEqual(copied.crlEntryExtensions);
    }
  });

  it("returns all 10 000 entries", { timeout: 120_000 }, () => {
    const der = withEntries(10_000);
    // What the CRL detail does with the stored blob: parse it, then build the projection.
    const started = performance.now();
    const crl = parseCRL(der);
    const parsed = performance.now();
    const { count, items } = buildTBSCertList(crl).revokedCertificates;
    const built = performance.now();
    expect(count).toBe(10_000);
    expect(items).toHaveLength(count);
    expect(items.at(-1)?.userCertificate.decimal).toBe("10000");
    // Recorded for slice 5a exit condition 9 (no threshold).
    console.info(
      `CRL detail of 10 000 revoked entries (${der.byteLength} bytes): parseCRL ` +
        `${(parsed - started).toFixed(0)} ms, buildTBSCertList ${(built - parsed).toFixed(0)} ms`
    );
  });
});
