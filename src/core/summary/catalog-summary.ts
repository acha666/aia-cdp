// Catalog summaries (plan §5.3). A summary is always built whole and replaces the previous one (no
// merge, no summary version), so there is one implementation of each summary.
import type { Certificate, CertificateRevocationList } from "pkijs";
import type { z } from "zod";
import type { CertificateSummarySchema, CrlSummarySchema } from "../catalog.ts";
import { sha1Hex, toHex } from "../digest.ts";
import { PkiParseError } from "../pki/errors.ts";
import type { PkiKind } from "../pki/errors.ts";
import {
  getAuthorityKeyIdHex,
  getCommonName,
  getCRLInteger,
  getNextCRLPublish,
  getSKIHex,
} from "../pki/parsers.ts";

// The two summaries in their catalog format.
export type CertificateSummary = z.infer<typeof CertificateSummarySchema>;
export type CrlSummary = z.infer<typeof CrlSummarySchema>;

/** `read()`, with whatever it throws reported as a malformed extension of `kind`. */
export function readExtension<T>(kind: PkiKind, name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new PkiParseError(kind, "extension_value", `Invalid ${name} extension`, {
      cause: error,
    });
  }
}

// A malformed SKI / AKI rejects the certificate, never skipped silently. An empty key id is
// rejected too: it cannot identify a key, and the catalog format requires hex.
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
    subjectCN: getCommonName(cert.subject) ?? null,
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

/** The fields of a CRL summary that the CRL's own fields and extensions give. */
export type CrlFields = Omit<CrlSummary, "revokedCount" | "sha1">;

/**
 * The CrlFields of a CRL from parseCRL or parseCrlHeader (so its times are valid RFC 5280 times).
 * Throws PkiParseError (kind "crl", reason "extension_value") when the CRL Number or the Delta CRL
 * Indicator (exactly one INTEGER ≥ 0, not longer than MAX_CRL_NUMBER_OCTETS) is present but
 * malformed. A Next CRL Publish that cannot be read is null, like a missing one.
 */
export function readCrlFields(crl: CertificateRevocationList): CrlFields {
  const crlNumber = readExtension("crl", "CRL Number", () => getCRLInteger(crl, "2.5.29.20"));
  const base = readExtension("crl", "Delta CRL Indicator", () => getCRLInteger(crl, "2.5.29.27"));
  return {
    crlNumber: crlNumber?.toString(10) ?? null,
    baseCrlNumber: base?.toString(10) ?? null,
    thisUpdate: crl.thisUpdate.value.toISOString(),
    nextUpdate: crl.nextUpdate?.value.toISOString() ?? null,
    nextPublish: getNextCRLPublish(crl)?.toISOString() ?? null,
  };
}

/**
 * Summary of a CRL parsed by parseCRL from `der`, in the catalog format of `current.summary`.
 * Throws like readCrlFields.
 */
export async function buildCrlSummary(
  crl: CertificateRevocationList,
  der: Uint8Array
): Promise<CrlSummary> {
  const { nextPublish, ...fields } = readCrlFields(crl);
  return {
    ...fields,
    revokedCount: crl.revokedCertificates?.length ?? 0,
    sha1: await sha1Hex(der),
    nextPublish,
  };
}
