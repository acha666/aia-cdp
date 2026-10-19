// One error type for every way an uploaded certificate or CRL can be unusable, thrown by toDer
// (PEM), the strict parsers and the summary builders. Callers map it without inspecting messages:
// kind "certificate" → 422 invalid_certificate (import, slice 2), "crl" → 422 invalid_crl
// (publish, slice 4), `reason` → `details.reason` (implementation §2.6). The message is for the log.

/** What the bytes were supposed to be. */
export type PkiKind = "certificate" | "crl";

/** The `details.reason` vocabulary of invalid_certificate / invalid_crl. */
export const PKI_PARSE_REASONS = [
  // Not decodable as BER / DER, or asn1js flagged a decoder error.
  "der",
  // Bytes after the single top-level element.
  "trailing_bytes",
  // A UTCTime / GeneralizedTime not in the only form RFC 5280 permits.
  "time",
  // Decodable, but not a certificate / CRL (PKIjs rejected the structure).
  "structure",
  // An extension the service reads (SKI, AKI, CRL Number, Delta CRL Indicator) is malformed.
  "extension_value",
  // A PEM boundary whose label is not the kind's (CERTIFICATE / X509 CRL).
  "pem_label",
  // Not exactly one complete PEM block (missing END line, or a bundle).
  "pem_blocks",
  // The PEM body is not valid base64.
  "pem_base64",
] as const;

export type PkiParseReason = (typeof PKI_PARSE_REASONS)[number];

export class PkiParseError extends Error {
  override name = "PkiParseError";
  readonly kind: PkiKind;
  readonly reason: PkiParseReason;

  constructor(kind: PkiKind, reason: PkiParseReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.reason = reason;
  }
}
