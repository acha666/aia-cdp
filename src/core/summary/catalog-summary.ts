// Catalog summaries (plan §5.3; formats in implementation slice 2 step 4). The field derivation
// comes from worker-aia-cdp@5b570aa:src/worker/r2/summary.ts:68-86 (buildCertificateMetadata);
// ensureSummaryMetadata, the metadata merge and SUMMARY_VERSION are not migrated: a summary is
// always built whole and replaces the previous one. Slice 4 adds buildCrlSummary here, so there is
// one implementation of each summary.
import type { Certificate } from "pkijs";
import { sha1Hex, toHex } from "../pki/conversion.ts";
import { PkiParseError } from "../pki/errors.ts";
import { getAuthorityKeyIdHex, getCN, getCommonName, getSKIHex } from "../pki/parsers.ts";

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

// The old code skipped a malformed SKI / AKI silently (M5); here it rejects the certificate. An
// empty key id is rejected too: it cannot identify a key, and the catalog format requires hex.
function readKeyId(name: string, read: () => string | undefined): string | null {
  let keyId: string | undefined;
  try {
    keyId = read();
  } catch (error) {
    throw new PkiParseError("certificate", "extension_value", `Invalid ${name} extension`, {
      cause: error,
    });
  }
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
