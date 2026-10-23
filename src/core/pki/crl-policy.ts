// Extension and clock policy of an uploaded CRL (plan §6). checkCrlPolicy runs on parseCrlHeader's
// CRL before the signature check (verify.ts), checkEntryPolicy on the whole CRL once the signature
// verified. The signature check bypasses PKIjs's own CRL check and with it PKIjs's list of critical
// extensions: these tables are the only extension gate.
import { Sequence } from "asn1js";
import type { CertificateRevocationList, Extension } from "pkijs";
import { toHex } from "../digest.ts";
import { readExtensionSchema } from "./extensions.ts";
import { sameSignatureAlgorithms } from "./parsers.ts";
import type { ReceivedCrl } from "./parsers.ts";

/** How far thisUpdate may lie ahead of the clock: exactly five minutes is still accepted. */
export const MAX_CLOCK_SKEW_MS = 300_000;

/**
 * CRL extensions the service recognizes, accepted whether or not they are marked critical:
 * recognition does not depend on criticality.
 */
const RECOGNIZED_CRL_EXTENSIONS: ReadonlySet<string> = new Set([
  "2.5.29.20", // CRL Number
  "2.5.29.27", // Delta CRL Indicator
  "2.5.29.35", // Authority Key Identifier
  "2.5.29.46", // Freshest CRL
  "2.5.29.18", // Issuer Alternative Name (PKIjs accepts it critical too)
  "1.3.6.1.5.5.7.1.1", // Authority Information Access (likewise)
  "1.3.6.1.4.1.311.21.1", // AD CS CA Version
  "1.3.6.1.4.1.311.21.4", // AD CS Next CRL Publish
  "1.3.6.1.4.1.311.21.14", // AD CS CRL Self CDP
]);

export const ISSUING_DISTRIBUTION_POINT_OID = "2.5.29.28";

/** CRL entry extensions accepted whether or not they are marked critical (RFC 5280 §5.3). */
const RECOGNIZED_ENTRY_EXTENSIONS: ReadonlySet<string> = new Set([
  "2.5.29.21", // reasonCode
  "2.5.29.24", // invalidityDate
  "2.5.29.23", // holdInstructionCode
]);

/** An entry naming another issuer makes the CRL indirect (RFC 5280 §5.3.3). */
export const CERTIFICATE_ISSUER_OID = "2.5.29.29";

/**
 * A violation, one variant per error code of implementation §2.6; publishCrl maps `error` and
 * `details` to the envelope as they are and keeps `detail` for its log line. `serialNumber` (the
 * entry of an entry extension) is uppercase hex like the catalog's.
 */
export type CrlPolicyFailure =
  | {
      ok: false;
      error: "invalid_crl";
      details: { reason: "signature_algorithm_mismatch" | "extension_value" };
      detail: string;
    }
  | { ok: false; error: "not_yet_valid"; details: { thisUpdate: string }; detail: string }
  | {
      ok: false;
      error: "unknown_critical_extension" | "scoped_crl_unsupported";
      details: { oid: string; serialNumber?: string };
      detail: string;
    };

export type CrlPolicyResult =
  | {
      ok: true;
      /** nextUpdate has passed: accepted, and logged (plan §6). */
      expired: boolean;
    }
  | CrlPolicyFailure;

/**
 * Whether an IssuingDistributionPoint holds a field other than distributionPoint [0] (RFC 5280
 * §5.2.5: the others limit the scope of the CRL). Throws when the value is not a SEQUENCE.
 */
function limitsScope(extension: Extension): boolean {
  const value = readExtensionSchema(extension);
  if (!(value instanceof Sequence)) {
    throw new Error("IssuingDistributionPoint is not a SEQUENCE");
  }
  return value.valueBlock.value.some(
    ({ idBlock }) => idBlock.tagClass !== 3 || idBlock.tagNumber !== 0
  );
}

function serialOf(serial: { valueBlock: { valueHexView: Uint8Array } }): string {
  return toHex(serial.valueBlock.valueHexView).toUpperCase();
}

/**
 * The upload policy of the CRL itself, in this order, the first violation winning:
 *
 * 1. The outer signatureAlgorithm and the TBS signature must be the same octets as received, OID
 *    and parameters (RFC 5280 §5.1.1.2) → invalid_crl / signature_algorithm_mismatch. Received,
 *    not re-encoded: the outer one is outside the signature, and asn1js would re-encode some
 *    non-DER forms canonically.
 * 2. Clock, in epoch milliseconds: thisUpdate more than MAX_CLOCK_SKEW_MS after `now` →
 *    not_yet_valid; a nextUpdate before `now` is accepted with `expired: true`.
 * 3. CRL extensions in their order: the recognized ones are accepted critical or not. The Issuing
 *    Distribution Point is read whatever its criticality: naming only the distributionPoint (the AD
 *    CS CDP option) is accepted; any other field → scoped_crl_unsupported, also when the IDP is not
 *    marked critical, against RFC 5280 which requires it to be: the service keeps one full and one
 *    delta CRL per issuer, and a partition published as the issuer's CRL would read as complete to
 *    a client that skips a non-critical IDP; a value that is not a SEQUENCE → invalid_crl /
 *    extension_value. Any other extension: critical → unknown_critical_extension, otherwise
 *    accepted (its bytes stay in the blob).
 *
 * Pure: nothing but `crl` and `now` is read, and the signature is not checked. The entries are
 * checkEntryPolicy's.
 */
export function checkCrlPolicy(crl: ReceivedCrl, now: Date): CrlPolicyResult {
  if (!sameSignatureAlgorithms(crl)) {
    return {
      ok: false,
      error: "invalid_crl",
      details: { reason: "signature_algorithm_mismatch" },
      detail: `signatureAlgorithm ${toHex(crl.signatureAlgorithmView)} differs from the TBS signature ${toHex(crl.signatureView)}`,
    };
  }

  const thisUpdate = crl.thisUpdate.value;
  if (thisUpdate.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "not_yet_valid",
      details: { thisUpdate: thisUpdate.toISOString() },
      detail: `thisUpdate ${thisUpdate.toISOString()} is ahead of ${now.toISOString()}`,
    };
  }
  const nextUpdate = crl.nextUpdate?.value;
  const expired = nextUpdate !== undefined && nextUpdate.getTime() < now.getTime();

  for (const extension of crl.crlExtensions?.extensions ?? []) {
    const oid = extension.extnID;
    if (RECOGNIZED_CRL_EXTENSIONS.has(oid)) {
      continue;
    }
    if (oid === ISSUING_DISTRIBUTION_POINT_OID) {
      let scoped: boolean;
      try {
        scoped = limitsScope(extension);
      } catch (error) {
        return {
          ok: false,
          error: "invalid_crl",
          details: { reason: "extension_value" },
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (scoped) {
        return {
          ok: false,
          error: "scoped_crl_unsupported",
          details: { oid },
          detail: "The Issuing Distribution Point limits the scope of the CRL",
        };
      }
      continue;
    }
    if (extension.critical) {
      return {
        ok: false,
        error: "unknown_critical_extension",
        details: { oid },
        detail: `Unrecognized critical CRL extension ${oid}`,
      };
    }
  }

  return { ok: true, expired };
}

/**
 * The upload policy of the revoked entries, the first violation winning: reasonCode, invalidityDate
 * and holdInstructionCode are accepted critical or not; certificateIssuer (an indirect CRL) →
 * scoped_crl_unsupported; any other critical one → unknown_critical_extension, both with the
 * entry's serial number. Pure, like checkCrlPolicy.
 */
export function checkEntryPolicy(crl: CertificateRevocationList): { ok: true } | CrlPolicyFailure {
  for (const entry of crl.revokedCertificates ?? []) {
    for (const extension of entry.crlEntryExtensions?.extensions ?? []) {
      const oid = extension.extnID;
      if (RECOGNIZED_ENTRY_EXTENSIONS.has(oid)) {
        continue;
      }
      if (oid === CERTIFICATE_ISSUER_OID) {
        const serialNumber = serialOf(entry.userCertificate);
        return {
          ok: false,
          error: "scoped_crl_unsupported",
          details: { oid, serialNumber },
          detail: `Entry ${serialNumber} names a certificate issuer (indirect CRL)`,
        };
      }
      if (extension.critical) {
        const serialNumber = serialOf(entry.userCertificate);
        return {
          ok: false,
          error: "unknown_critical_extension",
          details: { oid, serialNumber },
          detail: `Unrecognized critical extension ${oid} on entry ${serialNumber}`,
        };
      }
    }
  }
  return { ok: true };
}
