import { describe, expect, it } from "vitest";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import { buildCrlSummary } from "../../../src/core/summary/catalog-summary.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import { crlWithEntries, ENTRIES_SOURCE } from "../../helpers/pki.ts";

// The CRL detail returns every revoked entry (slice 5a step 3): the v2 builder returned a page of
// 10, and every fixture CRL has at most 2, so these CRLs copy the entries of a fixture CRL to more
// than a page (crlWithEntries; the signature no longer matches, which building the detail does
// not check).

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
    const der = crlWithEntries(11);
    const crl = parseCRL(der);
    const { count, items } = buildTBSCertList(crl).revokedCertificates;
    expect(count).toBe(11);
    expect(items).toHaveLength(count);
    expect(count).toBe((await buildCrlSummary(crl, der)).revokedCount);
    expect(items.map((item) => item.userCertificate.decimal)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1))
    );
    const source = buildTBSCertList(parseCRL(fixture(ENTRIES_SOURCE))).revokedCertificates.items;
    for (const [index, item] of items.entries()) {
      const copied = source[index % source.length]!;
      expect(item.revocationDate).toEqual(copied.revocationDate);
      expect(item.crlEntryExtensions).toEqual(copied.crlEntryExtensions);
    }
  });

  it("returns all 10 000 entries", { timeout: 120_000 }, () => {
    const der = crlWithEntries(10_000);
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
