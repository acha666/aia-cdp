// Catalog summaries (plan §5.3; formats in implementation slice 2 step 4 and slice 4 step 2). The
// field derivation comes from worker-aia-cdp@5b570aa:src/worker/r2/summary.ts:68-112
// (buildCertificateMetadata, buildCrlMetadata); ensureSummaryMetadata, the metadata merge and
// SUMMARY_VERSION are not migrated: a summary is always built whole and replaces the previous one,
// so there is one implementation of each summary.
import type { Certificate, CertificateRevocationList } from "pkijs";
import { sha1Hex, toHex } from "../pki/conversion.ts";
import { PkiParseError } from "../pki/errors.ts";
import type { PkiKind } from "../pki/errors.ts";
import {
  getAuthorityKeyIdHex,
  getCN,
  getCommonName,
  getCRLNumber,
  getDeltaBaseCRLNumber,
  getNextCRLPublish,
  getSKIHex,
} from "../pki/parsers.ts";

export interface CertificateSummary {
  /** First CN of the subject in RDN order, or null. */
  subjectCN: string | null;
  issuerCN: string | null;
  /** Uppercase hex of the INTEGER content bytes, leading 00 kept. */
  serialNumber: string;
  /** Date.toISOString(), e.g. 2025-01-01T00:00:00.000Z. */
  notBefore: string;
  notAfter: string;
  /** Lowercase hex, or null when the extension (or the AKI's keyIdentifier) is absent. */
  subjectKeyId: string | null;
  authorityKeyId: string | null;
  /** Lowercase hex SHA-1 of the DER. */
  sha1: string;
}

export interface CrlSummary {
  /** CRL Number in decimal (compared as BigInt), or null without the extension. */
  crlNumber: string | null;
  /** Delta CRL Indicator in decimal; null for a full CRL. */
  baseCrlNumber: string | null;
  /** Date.toISOString(). */
  thisUpdate: string;
  nextUpdate: string | null;
  /** Number of revokedCertificates entries; 0 when the list is absent. */
  revokedCount: number;
  /** Lowercase hex SHA-1 of the DER. */
  sha1: string;
  /** AD CS Next CRL Publish (1.3.6.1.4.1.311.21.4), Date.toISOString(); null when absent. */
  nextPublish: string | null;
}

/** `read()`, with whatever it throws reported as a malformed extension of `kind`. */
function readExtension<T>(kind: PkiKind, name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new PkiParseError(kind, "extension_value", `Invalid ${name} extension`, {
      cause: error,
    });
  }
}

// The old code skipped a malformed SKI / AKI silently (M5); here it rejects the certificate. An
// empty key id is rejected too: it cannot identify a key, and the catalog format requires hex.
function readKeyId(name: string, read: () => string | undefined): string | null {
  const keyId = readExtension("certificate", name, read);
  if (keyId === "") {
    throw new PkiParseError("certificate", "extension_value", `Empty ${name} key identifier`);
  }
  return keyId ?? null;
}

/**
 * Summary of a certificate parsed by parseCertificate (so its times are valid RFC 5280 times) from
 * `der`. Throws PkiParseError (kind "certificate", reason "extension_value") when the Subject or
 * Authority Key Identifier extension is present but malformed.
 */
export async function buildCertificateSummary(
  cert: Certificate,
  der: Uint8Array
): Promise<CertificateSummary> {
  return {
    subjectCN: getCN(cert) ?? null,
    issuerCN: getCommonName(cert.issuer) ?? null,
    serialNumber: toHex(cert.serialNumber.valueBlock.valueHexView).toUpperCase(),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    subjectKeyId: readKeyId("Subject Key Identifier", () => getSKIHex(cert)),
    authorityKeyId: readKeyId("Authority Key Identifier", () =>
      getAuthorityKeyIdHex(cert.extensions)
    ),
    sha1: await sha1Hex(der),
  };
}

/**
 * Summary of a CRL parsed by parseCRL (so its times are valid RFC 5280 times) from `der`, in the
 * catalog format of `current.summary`. Throws PkiParseError (kind "crl", reason "extension_value")
 * when the CRL Number, the Delta CRL Indicator (M2: an INTEGER ≥ 0, no size limit) or the AD CS
 * Next CRL Publish is present but malformed. A Next CRL Publish that is not exactly one RFC 5280
 * time is rejected like any other malformed extension the service reads, not stored as null:
 * slice 5b's status rule depends on it, and the CA that wrote it is misconfigured. (A time inside
 * the value that is not in the RFC 5280 form already fails parseCRL with reason "time".)
 */
export async function buildCrlSummary(
  crl: CertificateRevocationList,
  der: Uint8Array
): Promise<CrlSummary> {
  const crlNumber = readExtension("crl", "CRL Number", () => getCRLNumber(crl));
  const base = readExtension("crl", "Delta CRL Indicator", () => getDeltaBaseCRLNumber(crl));
  const nextPublish = readExtension("crl", "Next CRL Publish", () => getNextCRLPublish(crl));
  return {
    crlNumber: crlNumber?.toString(10) ?? null,
    baseCrlNumber: base?.toString(10) ?? null,
    thisUpdate: crl.thisUpdate.value.toISOString(),
    nextUpdate: crl.nextUpdate?.value.toISOString() ?? null,
    revokedCount: crl.revokedCertificates?.length ?? 0,
    sha1: await sha1Hex(der),
    nextPublish: nextPublish?.toISOString() ?? null,
  };
}
