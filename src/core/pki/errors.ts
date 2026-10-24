// One error type for every way an uploaded certificate or CRL can be unusable, thrown by toDer
// (PEM), the strict parsers and the summary builders. Callers map it without inspecting messages:
// kind "certificate" → 422 invalid_certificate (import), "crl" → 422 invalid_crl (publish),
// `reason` → `details.reason` (implementation §2.6). The message is for the log.

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
  // Decodable, but not a certificate / CRL (PKIjs rejected the structure), or one with a value the
  // catalog format cannot hold.
  "structure",
  // An extension the service reads (SKI, AKI, CRL Number, Delta CRL Indicator, AD CS Next CRL
  // Publish, Issuing Distribution Point) is malformed.
  "extension_value",
  // A PEM boundary whose label is not the kind's (CERTIFICATE / X509 CRL).
  "pem_label",
  // Not exactly one complete PEM block (missing END line, or a bundle).
  "pem_blocks",
  // The PEM body is not valid base64.
  "pem_base64",
  // The outer signatureAlgorithm is not the TBS signature as received: import and the CRL policy
  // answer it, no parser throws it.
  "signature_algorithm_mismatch",
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
