// Admin routes (plan §7.2): certificate import and deletion, config.json and CRL target history. An
// independent sub-app that createApp mounts at /api/v1 outside the AppType chain: the web client
// only gets the public routes' types; the CLI uses plain fetch.
//
// Every /api/v1/admin/* request first passes, in order: 503 admin_disabled while no token is
// configured (before auth, and before the body is read); bearerAuth (constant time; a missing or
// wrong token is 401 + WWW-Authenticate, a malformed Authorization header 400); bodyLimit
// (AIA_MAX_UPLOAD_BYTES, 413). Failures are thrown as ApiError / HTTPException, so onError writes
// every envelope (no-store) and the handlers only return successes.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { TypedResponse } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { JSONParsed } from "hono/utils/types";
import { applyConfig, schemaIssues } from "../../core/admin.ts";
import type { ConfigIssue, ConfigPrecondition } from "../../core/admin.ts";
import { CONFIG_KEY, ConfigSchema, encodeJson } from "../../core/catalog.ts";
import type { Config } from "../../core/catalog.ts";
import { deleteCertificate, importCertificate } from "../../core/certificates.ts";
import { sha256Hex } from "../../core/digest.ts";
import { CrlHistory, getHistoryBlob, listHistory } from "../../core/history.ts";
import { ApiError, NO_STORE, validationError } from "../errors.ts";
import { mediaTypeGate } from "../media.ts";
import {
  AdminDisabledError,
  BadRequestError,
  binary,
  CERTIFICATE_MEDIA_TYPES,
  CertificateConflictError,
  CertificateIdParam,
  ConcurrentUpdateError,
  ConfigInvalidError,
  HistoryVersionParam,
  ImportedCertificate,
  InvalidCertificateError,
  jsonContent,
  NotFoundError,
  PAYLOAD_TOO_LARGE,
  PreconditionFailedError,
  PreconditionRequiredError,
  rawBody,
  TargetIdParam,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from "../schemas.ts";
import type { AppDeps } from "../types.ts";

const SECURITY_SCHEME = "adminBearer";
const security = [{ [SECURITY_SCHEME]: [] }];
const tags = ["admin"];

// Shared responses -------------------------------------------------------------------------------

const ADMIN_FAILURES = {
  400: {
    description: "Malformed Authorization header, or an invalid request",
    content: jsonContent(BadRequestError),
  },
  401: {
    description: "Missing or wrong admin token",
    headers: z.object({ "WWW-Authenticate": z.string() }),
    content: jsonContent(UnauthorizedError),
  },
  503: {
    description: "No admin token is configured (AIA_ADMIN_TOKEN): the admin API is disabled",
    content: jsonContent(AdminDisabledError),
  },
} as const;

const UNSUPPORTED_MEDIA_TYPE = {
  description: "The Content-Type is missing or not one of the request body's media types",
  content: jsonContent(UnsupportedMediaTypeError),
};

const ETAG = z.object({
  ETag: z.string().openapi({
    description: 'The SHA-256 (lowercase hex) of the stored bytes, quoted: "<sha256>"',
  }),
});

// POST /admin/certificates -----------------------------------------------------------------------

// The format (DER or one PEM block) is recognized from the bytes; the type only gates 415.
const certificateMediaType = mediaTypeGate(
  CERTIFICATE_MEDIA_TYPES,
  "Send the certificate as application/pkix-cert, application/x-pem-file or " +
    "application/octet-stream"
);

const importCertificateRoute = createRoute({
  method: "post",
  path: "/admin/certificates",
  operationId: "importCertificate",
  summary: "Import a CA certificate",
  description:
    "DER or a single PEM block, as the request body; the format is recognized from the bytes. " +
    "Importing does not authorize anything: a certificate only issues CRLs once a config " +
    "target names it. A PEM bundle is rejected (`pem_blocks`): the CLI sends each block on its " +
    "own.",
  tags,
  security,
  middleware: [certificateMediaType],
  request: { body: rawBody(CERTIFICATE_MEDIA_TYPES) },
  responses: {
    200: {
      description: "Already imported: the stored entry, nothing was written",
      content: jsonContent(ImportedCertificate),
    },
    201: { description: "Imported", content: jsonContent(ImportedCertificate) },
    ...ADMIN_FAILURES,
    409: {
      description: "The catalog kept changing concurrently; retry",
      content: jsonContent(ConcurrentUpdateError),
    },
    413: PAYLOAD_TOO_LARGE,
    415: UNSUPPORTED_MEDIA_TYPE,
    422: {
      description: "Not a certificate this service accepts; `details.reason` says why",
      content: jsonContent(InvalidCertificateError),
    },
  },
});

// DELETE /admin/certificates/{id} ----------------------------------------------------------------

const deleteCertificateRoute = createRoute({
  method: "delete",
  path: "/admin/certificates/{id}",
  operationId: "deleteCertificate",
  summary: "Delete a CA certificate",
  description:
    "Removes an imported certificate and its blob, unless config.json or the current CRL of a " +
    "target (also of one removed from config.json) references it: then 409 `referenced` with " +
    "`details.references`. The verifier of a target's current CRL stays referenced, also once " +
    "the target is removed.",
  tags,
  security,
  request: { params: CertificateIdParam },
  responses: {
    204: { description: "Deleted" },
    ...ADMIN_FAILURES,
    404: {
      description: "No certificate with this id is imported",
      content: jsonContent(NotFoundError),
    },
    409: {
      description: "Referenced, or the catalog kept changing concurrently (retry)",
      content: jsonContent(CertificateConflictError),
    },
  },
});

// GET / PUT /admin/config ------------------------------------------------------------------------

const getConfigRoute = createRoute({
  method: "get",
  path: "/admin/config",
  operationId: "getConfig",
  summary: "Read config.json",
  description:
    "The stored bytes as they are, also when an out-of-band write left them invalid (so that " +
    "they can be repaired). The ETag is the SHA-256 of those bytes, for `If-Match` on PUT.",
  tags,
  security,
  responses: {
    200: {
      description: "The stored config.json",
      headers: ETAG,
      content: jsonContent(ConfigSchema),
    },
    404: { description: "Nothing has been configured yet", content: jsonContent(NotFoundError) },
    ...ADMIN_FAILURES,
  },
});

const STRONG_SHA256_ETAG = /^"([0-9a-f]{64})"$/;

/**
 * The precondition of PUT /admin/config: exactly one of `If-Match` or `If-None-Match: *`. Neither,
 * both, or an If-None-Match other than `*` → 428 precondition_required. An If-Match that is not one
 * strong ETag as GET sends it (`W/`, a list, unquoted, `*`) can never match → 412; so can a
 * well-formed one for another state (applyConfig).
 */
function configPrecondition(headers: Headers): ConfigPrecondition {
  const ifMatch = headers.get("If-Match");
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifMatch === null && ifNoneMatch === "*") {
    return { ifNoneMatch: "*" };
  }
  if (ifMatch === null || ifNoneMatch !== null) {
    throw new ApiError(
      "precondition_required",
      'Send exactly one of If-Match: "<ETag of GET>" or If-None-Match: * (first configuration)'
    );
  }
  const digest = STRONG_SHA256_ETAG.exec(ifMatch)?.[1];
  if (digest === undefined) {
    throw preconditionFailed();
  }
  return { ifMatch: digest };
}

function preconditionFailed(): ApiError {
  return new ApiError(
    "precondition_failed",
    "The precondition does not hold for the stored configuration: GET it again"
  );
}

function configInvalid(issues: ConfigIssue[]): ApiError {
  return new ApiError("config_invalid", "The configuration is invalid", { issues });
}

const applyConfigRoute = createRoute({
  method: "put",
  path: "/admin/config",
  operationId: "applyConfig",
  summary: "Replace config.json",
  description:
    "The whole configuration, checked against rules V1–V9 (every violation in " +
    '`details.issues`). Exactly one precondition: `If-Match: "<ETag>"` from GET, or ' +
    "`If-None-Match: *` for the first configuration.",
  tags,
  security,
  request: {
    headers: z.object({
      "If-Match": z
        .string()
        .optional()
        .openapi({ description: 'The ETag from GET, as sent: "<sha256>"' }),
      "If-None-Match": z
        .string()
        .optional()
        .openapi({ description: "`*`: only while nothing is configured" }),
    }),
    body: { required: true, content: jsonContent(ConfigSchema) },
  },
  responses: {
    200: {
      description: "Applied: the stored bytes and their new ETag",
      headers: ETAG,
      content: jsonContent(ConfigSchema),
    },
    ...ADMIN_FAILURES,
    412: {
      description: "The precondition does not hold (another apply came first, or W/ / list / *)",
      content: jsonContent(PreconditionFailedError),
    },
    413: PAYLOAD_TOO_LARGE,
    415: UNSUPPORTED_MEDIA_TYPE,
    422: {
      description: "The configuration breaks rules V1–V9",
      content: jsonContent(ConfigInvalidError),
    },
    428: {
      description: "Not exactly one of If-Match and If-None-Match: *",
      content: jsonContent(PreconditionRequiredError),
    },
  },
});

// GET /admin/crls/{targetId}/history[/{sha256}] -------------------------------------------------

const getHistoryRoute = createRoute({
  method: "get",
  path: "/admin/crls/{targetId}/history",
  operationId: "getCrlHistory",
  summary: "List a CRL target's history",
  description:
    "Every version that was published as the target's current CRL, newest first: the superseded " +
    "ones and the current one, also for a target removed from config.json (retired). Blobs that " +
    "a lost publish race left behind are not history.",
  tags,
  security,
  request: { params: TargetIdParam },
  responses: {
    200: { description: "The history", content: jsonContent(CrlHistory) },
    ...ADMIN_FAILURES,
    404: {
      description: "The target is neither in config.json nor has a history",
      content: jsonContent(NotFoundError),
    },
  },
});

const getHistoryVersionRoute = createRoute({
  method: "get",
  path: "/admin/crls/{targetId}/history/{sha256}",
  operationId: "getCrlHistoryVersion",
  summary: "Download a version of a CRL target's history",
  description: 'The DER as stored, as an attachment named "<sha256>.crl".',
  tags,
  security,
  request: { params: HistoryVersionParam },
  responses: {
    200: {
      description: "The DER",
      headers: z.object({ "Content-Disposition": z.string() }),
      content: { "application/pkix-crl": { schema: binary } },
    },
    ...ADMIN_FAILURES,
    404: {
      description: "The target's history has no version with this SHA-256",
      content: jsonContent(NotFoundError),
    },
  },
});

/**
 * config.json bytes with the HTTP ETag (the SHA-256 of exactly these bytes, never the store's
 * ETag). Typed as the route's JSON body, which the bytes are unless an out-of-band write broke
 * them: GET passes such bytes through as they are.
 */
function configResponse(bytes: Uint8Array, sha256: string) {
  // A copy: an adapter may hand out a view into a larger buffer.
  const res = new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: `"${sha256}"`, ...NO_STORE },
  });
  return res as unknown as TypedResponse<JSONParsed<Config>, 200, "json">;
}

// Sub-app ----------------------------------------------------------------------------------------

export function adminRoutes(deps: AppDeps) {
  const { log } = deps;
  const admin = new OpenAPIHono();

  admin.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    description: "AIA_ADMIN_TOKEN",
  });

  const token = deps.settings.adminToken;
  if (token === undefined) {
    admin.use(
      "/admin/*",
      createMiddleware(async () => {
        throw new ApiError(
          "admin_disabled",
          "The admin API is disabled: no admin token is configured"
        );
      })
    );
  } else {
    admin.use(
      "/admin/*",
      bearerAuth({ token }),
      bodyLimit({ maxSize: deps.settings.maxUploadBytes })
    );
  }

  admin.openapi(importCertificateRoute, async (c) => {
    const bytes = await c.req.bytes();
    if (bytes.byteLength === 0) {
      throw new ApiError("bad_request", "Expected a certificate in the request body");
    }

    const result = await importCertificate(deps, bytes);
    if ("error" in result) {
      if (result.error === "invalid_certificate") {
        log({ level: "warn", msg: "import", reason: result.details.reason });
        throw new ApiError("invalid_certificate", "Not a valid X.509 certificate", result.details);
      }
      log({ level: "warn", msg: "import", certificateId: result.id, reason: result.error });
      throw new ApiError(
        "concurrent_update",
        "The catalog kept changing concurrently: retry the import"
      );
    }
    log({ level: "info", msg: "import", certificateId: result.id, outcome: result.outcome });
    const { size, importedAt, summary } = result.entry;
    const body = { outcome: result.outcome, id: result.id, size, importedAt, summary };
    return result.outcome === "created" ? c.json(body, 201, NO_STORE) : c.json(body, 200, NO_STORE);
  });

  admin.openapi(deleteCertificateRoute, async (c) => {
    const { id } = c.req.valid("param");
    const result = await deleteCertificate(deps, id);
    if (!("error" in result)) {
      log({ level: "info", msg: "delete_certificate", certificateId: id });
      return c.body(null, 204, NO_STORE);
    }
    if (result.error === "not_found") {
      throw new ApiError("not_found", "No certificate with this id is imported");
    }
    log({ level: "warn", msg: "delete_certificate", certificateId: id, reason: result.error });
    throw result.error === "referenced"
      ? new ApiError(
          "referenced",
          "The certificate is referenced: remove the references from config.json first, or keep " +
            "it (the verifier of a target's current CRL stays referenced)",
          result.details
        )
      : new ApiError("concurrent_update", "The catalog kept changing concurrently: retry");
  });

  admin.openapi(getHistoryRoute, async (c) => {
    const { targetId } = c.req.valid("param");
    const history = await listHistory(deps, targetId);
    if ("error" in history) {
      throw new ApiError("not_found", "No target with this id is configured or has a history");
    }
    return c.json(history, 200, NO_STORE);
  });

  admin.openapi(getHistoryVersionRoute, async (c) => {
    const { targetId, sha256 } = c.req.valid("param");
    const found = await getHistoryBlob(deps, targetId, sha256);
    if ("error" in found) {
      throw new ApiError("not_found", "The target's history has no CRL with this SHA-256");
    }
    return c.body(found.der, 200, {
      "Content-Type": "application/pkix-crl",
      "Content-Disposition": `attachment; filename="${sha256}.crl"`,
      "Content-Length": String(found.der.byteLength),
      ...NO_STORE,
    });
  });

  admin.openapi(getConfigRoute, async () => {
    const stored = await deps.store.get(CONFIG_KEY);
    if (stored === null) {
      throw new ApiError("not_found", "Nothing has been configured yet");
    }
    return configResponse(stored.bytes, await sha256Hex(stored.bytes));
  });

  admin.openapi(
    applyConfigRoute,
    async (c) => {
      const result = await applyConfig(
        deps,
        c.req.valid("json"),
        configPrecondition(c.req.raw.headers)
      );
      if ("error" in result) {
        throw result.error === "precondition_failed"
          ? preconditionFailed()
          : configInvalid(result.details.issues);
      }
      return configResponse(encodeJson(result.config), result.sha256);
    },
    // ConfigSchema validates the body before the handler runs: a failure is config_invalid (rule
    // V1), not the default 400, whatever the precondition. Without a JSON Content-Type the
    // validator checks `{}`.
    (result) => {
      if (result.success) {
        return undefined;
      }
      throw result.target === "json"
        ? configInvalid(schemaIssues(result.error))
        : validationError(result.target, result.error);
    }
  );

  return admin;
}
