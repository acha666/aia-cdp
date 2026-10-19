import { z } from "@hono/zod-openapi";

/** Every error code of plan §7.3. Each route narrows the enum per status code (errorSchema). */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "admin_disabled",
  "precondition_failed",
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
 * The failure envelope `{ error: { code, message, details? } }` for one status code, with `code`
 * narrowed to what that status can carry. Callers name it: `errorSchema([...]).openapi("…")`.
 */
export function errorSchema<const C extends readonly [ErrorCode, ...ErrorCode[]]>(codes: C) {
  return z.object({
    error: z.object({
      code: z.enum(codes),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  });
}

/** 200: the store answers. `degraded` while config.json is missing or invalid. */
export const HealthOk = z
  .object({
    status: z.enum(["healthy", "degraded"]),
    checks: z.object({
      store: z.literal("ok"),
      configuration: z.enum(["ok", "missing", "invalid"]),
    }),
  })
  .openapi("HealthOk");

/** 503: the store failed, so the configuration could not be checked. */
export const HealthUnavailable = z
  .object({
    status: z.literal("unhealthy"),
    checks: z.object({
      store: z.literal("error"),
      configuration: z.literal("unknown"),
    }),
  })
  .openapi("HealthUnavailable");
