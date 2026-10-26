import { z } from "@hono/zod-openapi";
import {
  CertificateSummarySchema,
  CrlKind,
  CrlSummarySchema,
  Sha256Hex,
  TargetId,
  Timestamp,
} from "../core/catalog.ts";
import { Size } from "../core/history.ts";
import {
  AlgorithmIdentifierSchema,
  FingerprintsSchema,
  SignatureValueSchema,
  TBSCertificateSchema,
  TBSCertListSchema,
} from "../core/summary/schemas.ts";

/** All API failures use the same envelope. Codes and details describe the failure. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("ErrorResponse");

/** The `content` of a JSON request body or response. */
export function jsonContent<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

/** A response with a JSON body. */
export function jsonResponse<S extends z.ZodType>(description: string, schema: S) {
  return { description, content: jsonContent(schema) };
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

/** The 500 of the certificate and CRL routes. */
export const INTERNAL_ERROR = jsonResponse(
  "The store failed, or it cannot back what catalog.json and config.json name (logged, never " +
    "sent); retry later",
  ErrorResponse
);

/** The 413 of every route that reads a request body. */
export const PAYLOAD_TOO_LARGE = jsonResponse(
  "The body is larger than AIA_MAX_UPLOAD_BYTES",
  ErrorResponse
);

// Admin --------------------------------------------------------------------------------------------

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
const CertificateTarget = z
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
const CrlIssuer = z
  .object({ id: Sha256Hex, label: z.string().nullable(), subjectCN: z.string().nullable() })
  .openapi("CrlIssuer");

/** A target's current CRL as the catalog records it at publish time. */
const CrlCurrent = z
  .object({
    /** SHA-256 of the DER. */
    sha256: Sha256Hex,
    size: Size,
    publishedAt: Timestamp,
    summary: CrlSummarySchema,
  })
  .openapi("CrlCurrent");

/** The current CRL of a target detail: every revoked entry, never a page. */
const CrlCurrentDetail = CrlCurrent.extend({
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
