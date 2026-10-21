// The error codes the web client can meet, as runtime arrays (implementation slice 5a step 10): the
// slice 5b i18n tests iterate them so that every code has an `errors.<code>` message. The web must
// not import src/http at run time (that would bundle zod), so ERROR_CODES repeats the list of
// src/http/schemas.ts; tests/web/client.typetest.ts makes any difference a compile error.

/** Every v1 error code (plan §7.3), in the order of src/http/schemas.ts. */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "admin_disabled",
  "precondition_failed",
  "precondition_required",
  "config_invalid",
  "referenced",
  "invalid_crl",
  "invalid_certificate",
  "not_yet_valid",
  "unknown_critical_extension",
  "scoped_crl_unsupported",
  "unsupported_algorithm",
  "issuer_not_found",
  "target_not_configured",
  "invalid_signature",
  "issuer_mismatch",
  "stale_crl",
  "conflict",
  "non_orderable",
  "concurrent_update",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes the client produces itself (src/web/client/errors.ts): `network` when no response arrived,
 * `invalid_response` when one arrived that is not the API's JSON.
 */
export const CLIENT_ERROR_CODES = ["network", "invalid_response"] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
