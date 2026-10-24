import { z } from "@hono/zod-openapi";
import { ConfigIssue } from "../core/admin.ts";
import {
  CertificateSummarySchema,
  CrlKind,
  CrlSummarySchema,
  Sha256Hex,
  TargetId,
  Timestamp,
} from "../core/catalog.ts";
import { CertificateReference } from "../core/certificates.ts";
import { PKI_PARSE_REASONS } from "../core/pki/errors.ts";
import { CurrentCrlVersion } from "../core/publish.ts";
import {
  AlgorithmIdentifierSchema,
  FingerprintsSchema,
  SignatureValueSchema,
  TBSCertificateSchema,
  TBSCertListSchema,
} from "../core/summary/schemas.ts";

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

/** The `content` of a JSON request body or response. */
export function jsonContent<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

/** A binary request body or response (DER). */
export const binary = z.string().openapi({ format: "binary" });

/**
 * The raw request body of an upload under each of `mediaTypes`: text for PEM, binary otherwise.
 * The format is always recognized from the bytes.
 */
export function rawBody(mediaTypes: readonly string[]) {
  return {
    required: true,
    content: Object.fromEntries(
      mediaTypes.map((type) => [
        type,
        { schema: type === "application/x-pem-file" ? z.string() : binary },
      ])
    ),
  };
}

/** Why an upload is not a certificate or CRL this service accepts. */
const ParseReason = z.enum(PKI_PARSE_REASONS);

const Size = z.number().int().positive().openapi({ description: "DER size in bytes" });

// Shared failures ---------------------------------------------------------------------------------

export const BadRequestError = errorSchema(["bad_request"]).openapi("BadRequestError");

export const UnauthorizedError = errorSchema(["unauthorized"]).openapi("UnauthorizedError");

export const NotFoundError = errorSchema(["not_found"]).openapi("NotFoundError");

const PayloadTooLargeError = errorSchema(["payload_too_large"]).openapi("PayloadTooLargeError");

export const UnsupportedMediaTypeError = errorSchema(["unsupported_media_type"]).openapi(
  "UnsupportedMediaTypeError"
);

export const ConcurrentUpdateError = errorSchema(["concurrent_update"]).openapi(
  "ConcurrentUpdateError"
);

const InternalError = errorSchema(["internal"]).openapi("InternalError");

/** The 500 of the certificate and CRL routes. */
export const INTERNAL_ERROR = {
  description:
    "The store failed, or it cannot back what catalog.json and config.json name (logged, never " +
    "sent); retry later",
  content: jsonContent(InternalError),
};

/** The 413 of every route that reads a request body. */
export const PAYLOAD_TOO_LARGE = {
  description: "The body is larger than AIA_MAX_UPLOAD_BYTES",
  content: jsonContent(PayloadTooLargeError),
};

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

/** The request media types of POST /api/v1/admin/certificates, for the raw body. */
export const CERTIFICATE_MEDIA_TYPES = [
  "application/pkix-cert",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

/** 200 / 201 of POST /api/v1/admin/certificates: the catalog entry, without its store key. */
export const ImportedCertificate = z
  .object({
    outcome: z.enum(["created", "unchanged"]),
    /** SHA-256 of the DER. */
    id: Sha256Hex,
    size: Size,
    importedAt: Timestamp,
    summary: CertificateSummarySchema,
  })
  .openapi("ImportedCertificate");

export const InvalidCertificateError = detailedErrorSchema(
  ["invalid_certificate"],
  z.object({ reason: ParseReason })
).openapi("InvalidCertificateError");

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

// CRL upload ---------------------------------------------------------------------------------------

/**
 * The request media types of POST /api/v1/crls, for the raw body. They only pass the gate: the
 * format (DER or one X509 CRL PEM block) is always recognized from the bytes.
 */
export const CRL_MEDIA_TYPES = [
  "application/pkix-crl",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

/** 200 / 201 of POST /api/v1/crls (plan §7.1). */
export const PublishedCrl = z
  .object({
    /** created → 201; updated, unchanged → 200. */
    outcome: z.enum(["created", "updated", "unchanged"]),
    /** The target the configuration binds to the CRL's issuer and kind. */
    target: TargetId,
    kind: CrlKind,
    /** SHA-256 of the DER: the target's current CRL after the upload. */
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    baseCrlNumber: CrlSummarySchema.shape.baseCrlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
    nextUpdate: CrlSummarySchema.shape.nextUpdate,
    /** Id of the issuer certificate the target names, whose key verified the signature. */
    issuer: Sha256Hex,
    /** The paths that serve the target, in code-unit order, each DER path before its `.pem`. */
    downloads: z.array(z.string()),
  })
  .openapi("PublishedCrl");

export const CrlConflictError = z
  .union([
    detailedErrorSchema(
      ["stale_crl", "conflict", "non_orderable"],
      z.object({ current: CurrentCrlVersion })
    ),
    ConcurrentUpdateError,
  ])
  .openapi("CrlConflictError");

/** `details` of 422 by code (src/core/publish.ts PublishFailure). */
export const CrlRejectedError = z
  .union([
    detailedErrorSchema(["invalid_crl"], z.object({ reason: ParseReason })),
    detailedErrorSchema(
      ["not_yet_valid"],
      z.object({ thisUpdate: CrlSummarySchema.shape.thisUpdate })
    ),
    detailedErrorSchema(
      ["unknown_critical_extension", "scoped_crl_unsupported"],
      z.object({
        oid: z.string(),
        /** Uppercase hex: only for a CRL entry extension. */
        serialNumber: z.string().optional(),
      })
    ),
    detailedErrorSchema(
      ["issuer_not_found"],
      z.union([
        z.object({ reason: z.literal("missing_aki") }),
        z.object({ authorityKeyId: z.string() }),
      ])
    ),
    detailedErrorSchema(
      ["target_not_configured"],
      z.object({
        kind: CrlKind,
        /** The imported certificates whose Subject Key Identifier is the CRL's AKI. */
        certificates: z.array(Sha256Hex),
      })
    ),
    detailedErrorSchema(
      ["invalid_signature", "unsupported_algorithm"],
      z.object({ algorithm: z.string() })
    ),
  ])
  .openapi("CrlRejectedError");

export const CrlMediaTypeError = detailedErrorSchema(
  ["unsupported_media_type"],
  z.object({
    /** The request's media type (lowercase, without parameters); null without a Content-Type. */
    received: z.string().nullable(),
    accepted: z.array(z.enum(CRL_MEDIA_TYPES)),
  })
).openapi("CrlMediaTypeError");

// Public reads (plan §7.1) ------------------------------------------------------------------------
// The bodies of src/core/views.ts. The X.509 projection is the core schemas as they are (named with
// .meta({ id }), so the document references them as components); only the wrappers are defined
// here.

/**
 * A SHA-256 path parameter: 64 hex digits in either case, normalised to lowercase. Checked before
 * it is lowercased, so the documented pattern is the input's (either case). One path segment, so
 * `/` (sent as `%2F`) is a 400.
 */
function sha256Param(description: string) {
  return z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .toLowerCase()
    .openapi({ description });
}

/** Path parameter of GET /api/v1/certificates/{id}, normalised to the lowercase catalog id. */
export const CertificateIdParam = z.object({
  id: sha256Param("The certificate id: SHA-256 of the DER, hex (either case)"),
});

/**
 * Path parameter of GET /api/v1/crls/{targetId}: an RFC 9562 UUID in either case (§4:
 * case-insensitive on input), normalised to lowercase like certificate ids. Lowercased before the
 * check: z.uuid() (the validator of config.json's target ids, used here as a check, which is what
 * the deprecated z.string().uuid() does) accepts the Max UUID in lowercase only. Documented as
 * format uuid.
 */
export const TargetIdParam = z.object({
  targetId: z
    .string()
    .toLowerCase()
    .check(z.uuid())
    .openapi({ description: "The target id from config.json (UUID, either case)" }),
});

/** Path parameters of GET /api/v1/admin/crls/{targetId}/history/{sha256}. */
export const HistoryVersionParam = TargetIdParam.extend({
  sha256: sha256Param("SHA-256 of the version's DER, hex (either case)"),
});

const Downloads = z.array(z.string()).openapi({
  description:
    "The paths that serve the resource (config.json's path table), in code-unit order, each DER " +
    "path followed by its `.pem`; [] when none is configured",
});

/** A configured target that names the certificate as its issuer. */
export const CertificateTarget = z
  .object({ targetId: TargetId, kind: CrlKind, label: z.string() })
  .openapi("CertificateTarget");

export const CertificateListItem = z
  .object({
    /** SHA-256 of the DER. */
    id: Sha256Hex,
    /** config.json's label; null when the certificate has none. */
    label: z.string().nullable(),
    importedAt: Timestamp,
    size: Size,
    summary: CertificateSummarySchema,
    downloads: Downloads,
    /** In targetId order. */
    targets: z.array(CertificateTarget),
  })
  .openapi("CertificateListItem");

/** The list item plus the projection of the stored DER, built whole on every request. */
export const CertificateDetail = CertificateListItem.extend({
  fingerprints: FingerprintsSchema,
  tbsCertificate: TBSCertificateSchema,
  signatureAlgorithm: AlgorithmIdentifierSchema,
  signatureValue: SignatureValueSchema,
}).openapi("CertificateDetail");

/** A target's issuer certificate: its id, config.json label and subject CN. */
export const CrlIssuer = z
  .object({ id: Sha256Hex, label: z.string().nullable(), subjectCN: z.string().nullable() })
  .openapi("CrlIssuer");

/** A target's current CRL as the catalog records it at publish time. */
export const CrlCurrent = z
  .object({
    /** SHA-256 of the DER. */
    sha256: Sha256Hex,
    size: Size,
    publishedAt: Timestamp,
    summary: CrlSummarySchema,
  })
  .openapi("CrlCurrent");

/** The current CRL of a target detail: every revoked entry, never a page. */
export const CrlCurrentDetail = CrlCurrent.extend({
  /** Id of the certificate whose key verified the signature. */
  verifier: Sha256Hex,
  fingerprints: FingerprintsSchema,
  tbsCertList: TBSCertListSchema,
  signatureAlgorithm: AlgorithmIdentifierSchema,
  signatureValue: SignatureValueSchema,
}).openapi("CrlCurrentDetail");

/**
 * A target's current CRL or null while nothing is published. A union rather than .nullable(): the
 * generator writes a nullable named schema as its bare $ref.
 */
function currentOrNull<S extends z.ZodType>(current: S) {
  return z.union([current, z.null()]).openapi({
    description: "null while nothing is published",
  });
}

const CrlTargetFields = {
  targetId: TargetId,
  /** From config.json, not from the CRL. */
  kind: CrlKind,
  label: z.string(),
  issuer: CrlIssuer,
  downloads: Downloads,
};

export const CrlTargetListItem = z
  .object({
    ...CrlTargetFields,
    current: currentOrNull(CrlCurrent),
  })
  .openapi("CrlTargetListItem");

export const CrlTargetDetail = z
  .object({
    ...CrlTargetFields,
    current: currentOrNull(CrlCurrentDetail),
  })
  .openapi("CrlTargetDetail");

const Count = z.number().int().nonnegative();

const KindCounts = z.object({ full: Count, delta: Count });

/** GET /api/v1/stats: counts and bytes from config.json and catalog.json; no time fields. */
export const Stats = z
  .object({
    /** Imported certificates. */
    certificates: Count,
    /** Configured targets by kind. */
    targets: KindCounts,
    /** Configured targets with a current CRL, by kind. */
    published: KindCounts,
    totalRevocations: Count.nullable().openapi({
      description:
        "Sum of revokedCount over the published full CRLs (delta entries reappear in the next " +
        "full CRL); null while no full CRL is published",
    }),
    derBytes: Count.openapi({
      description:
        "DER bytes of the imported certificates and of the configured targets' current CRLs " +
        "(history not counted)",
    }),
  })
  .openapi("Stats");

// Admin: history and certificate deletion ----------------------------------------------------------
// The bodies of src/core/history.ts and src/core/certificates.ts deleteCertificate.

/** One version of a target's history. */
export const CrlHistoryEntry = z
  .object({
    /** SHA-256 of the DER. */
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
    size: Size,
    current: z.boolean().openapi({
      description: "The version the target serves: its current CRL, while it is in config.json",
    }),
  })
  .openapi("CrlHistoryEntry");

/** GET /api/v1/admin/crls/{targetId}/history. */
export const CrlHistory = z
  .object({
    targetId: TargetId,
    configured: z.boolean().openapi({
      description: "false once the target was removed from config.json: nothing serves it",
    }),
    entries: z.array(CrlHistoryEntry).openapi({
      description: "Newest first: by thisUpdate, then CRL Number",
    }),
  })
  .openapi("CrlHistory");

/** 409 of DELETE /api/v1/admin/certificates/{id}. */
export const CertificateConflictError = z
  .union([
    detailedErrorSchema(["referenced"], z.object({ references: z.array(CertificateReference) })),
    ConcurrentUpdateError,
  ])
  .openapi("CertificateConflictError");
