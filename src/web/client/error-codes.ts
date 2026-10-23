// The error codes the web client can meet, as runtime arrays: every code has an `errors.<code>`
// message. The web must not import src/http at run time (that would bundle zod), so V1_CODES
// repeats the codes of src/http/schemas.ts; its `satisfies` makes a missing or an extra code a
// compile error.
import type { ErrorCode as ServerErrorCode } from "../../http/schemas.ts";

const V1_CODES = {
  bad_request: true,
  unauthorized: true,
  not_found: true,
  method_not_allowed: true,
  payload_too_large: true,
  unsupported_media_type: true,
  admin_disabled: true,
  precondition_failed: true,
  precondition_required: true,
  config_invalid: true,
  referenced: true,
  invalid_crl: true,
  invalid_certificate: true,
  not_yet_valid: true,
  unknown_critical_extension: true,
  scoped_crl_unsupported: true,
  unsupported_algorithm: true,
  issuer_not_found: true,
  target_not_configured: true,
  invalid_signature: true,
  stale_crl: true,
  conflict: true,
  non_orderable: true,
  concurrent_update: true,
  internal: true,
} satisfies Record<ServerErrorCode, true>;

/** Every v1 error code (plan §7.3), in the order of src/http/schemas.ts. */
export const ERROR_CODES = Object.keys(V1_CODES) as readonly ServerErrorCode[];

/**
 * Codes the client produces itself (src/web/client/errors.ts): `network` when no response arrived,
 * `invalid_response` when one arrived that is not the API's JSON.
 */
export const CLIENT_ERROR_CODES = ["network", "invalid_response"] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
