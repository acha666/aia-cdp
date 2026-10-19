import { z } from "@hono/zod-openapi";
import { CONFIG_RULES } from "../core/admin.ts";
import { CertificateSummarySchema, Sha256Hex } from "../core/catalog.ts";
import { PKI_PARSE_REASONS } from "../core/pki/errors.ts";

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

type ErrorCodes = readonly [ErrorCode, ...ErrorCode[]];

/**
 * The failure envelope `{ error: { code, message, details? } }` for one status code, with `code`
 * narrowed to what that status can carry. Callers name it: `errorSchema([...]).openapi("…")`.
 */
export function errorSchema<const C extends ErrorCodes>(codes: C) {
  return detailedErrorSchema(codes, z.unknown().optional());
}

/** errorSchema with a documented `details` shape (only for docs: failures are thrown as ApiError). */
export function detailedErrorSchema<const C extends ErrorCodes, D extends z.ZodType>(
  codes: C,
  details: D
) {
  return z.object({
    error: z.object({ code: z.enum(codes), message: z.string(), details }),
  });
}

// Shared failures ---------------------------------------------------------------------------------

export const BadRequestError = errorSchema(["bad_request"]).openapi("BadRequestError");

export const UnauthorizedError = errorSchema(["unauthorized"]).openapi("UnauthorizedError");

export const NotFoundError = errorSchema(["not_found"]).openapi("NotFoundError");

export const PayloadTooLargeError = errorSchema(["payload_too_large"]).openapi(
  "PayloadTooLargeError"
);

export const UnsupportedMediaTypeError = errorSchema(["unsupported_media_type"]).openapi(
  "UnsupportedMediaTypeError"
);

export const ConcurrentUpdateError = errorSchema(["concurrent_update"]).openapi(
  "ConcurrentUpdateError"
);

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

// Admin --------------------------------------------------------------------------------------------

export const AdminDisabledError = errorSchema(["admin_disabled"]).openapi("AdminDisabledError");

/** 200 / 201 of POST /api/v1/admin/certificates: the catalog entry, without its store key. */
export const ImportedCertificate = z
  .object({
    outcome: z.enum(["created", "unchanged"]),
    /** SHA-256 of the DER. */
    id: Sha256Hex,
    size: z.number().int().positive(),
    importedAt: z.iso.datetime({ precision: 3 }),
    summary: CertificateSummarySchema,
  })
  .openapi("ImportedCertificate");

export const InvalidCertificateError = detailedErrorSchema(
  ["invalid_certificate"],
  z.object({ reason: z.enum(PKI_PARSE_REASONS) })
).openapi("InvalidCertificateError");

/** One entry of config_invalid's details.issues (src/core/admin.ts ConfigIssue). */
export const ConfigIssue = z
  .object({
    /** Keys from the document root; [] for the whole document. */
    path: z.array(z.union([z.string(), z.number()])),
    rule: z.enum(CONFIG_RULES),
    message: z.string(),
  })
  .openapi("ConfigIssue");

export const ConfigInvalidError = detailedErrorSchema(
  ["config_invalid"],
  z.object({ issues: z.array(ConfigIssue) })
).openapi("ConfigInvalidError");

export const PreconditionFailedError = errorSchema(["precondition_failed"]).openapi(
  "PreconditionFailedError"
);

export const PreconditionRequiredError = errorSchema(["precondition_required"]).openapi(
  "PreconditionRequiredError"
);
