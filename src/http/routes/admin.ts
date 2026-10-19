// Admin routes (plan §7.2, implementation slice 2 step 8): certificate import and config.json.
// An independent sub-app that createApp mounts at /api/v1 outside the AppType chain: the web
// client only gets the public routes' types (slice 5a step 8); the CLI uses plain fetch.
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
import { sha256Hex } from "../../core/digest.ts";
import { importCertificate } from "../../core/import.ts";
import { ApiError, ERROR_MESSAGES, NO_STORE, validationError } from "../errors.ts";
import { createLogger } from "../log.ts";
import {
  AdminDisabledError,
  BadRequestError,
  ConcurrentUpdateError,
  ConfigInvalidError,
  ImportedCertificate,
  InvalidCertificateError,
  NotFoundError,
  PayloadTooLargeError,
  PreconditionFailedError,
  PreconditionRequiredError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from "../schemas.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const SECURITY_SCHEME = "adminBearer";
const security = [{ [SECURITY_SCHEME]: [] }];

function json<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

// Shared responses -------------------------------------------------------------------------------

const ADMIN_FAILURES = {
  400: {
    description: "Malformed Authorization header, or an invalid request",
    content: json(BadRequestError),
  },
  401: {
    description: "Missing or wrong admin token",
    headers: z.object({ "WWW-Authenticate": z.string() }),
    content: json(UnauthorizedError),
  },
  503: {
    description: "No admin token is configured (AIA_ADMIN_TOKEN): the admin API is disabled",
    content: json(AdminDisabledError),
  },
} as const;

const PAYLOAD_TOO_LARGE = {
  description: "The body is larger than AIA_MAX_UPLOAD_BYTES",
  content: json(PayloadTooLargeError),
};

const UNSUPPORTED_MEDIA_TYPE = {
  description: "The Content-Type is not one of the request body's media types",
  content: json(UnsupportedMediaTypeError),
};

const ETAG = z.object({
  ETag: z.string().openapi({
    description: 'The SHA-256 (lowercase hex) of the stored bytes, quoted: "<sha256>"',
  }),
});

// POST /admin/certificates -----------------------------------------------------------------------

const MULTIPART = "multipart/form-data";

// The format (DER or one PEM block) is recognized from the bytes; the type only gates 415.
const CERTIFICATE_MEDIA_TYPES = new Set([
  "application/pkix-cert",
  "application/x-pem-file",
  "application/octet-stream",
  MULTIPART,
]);

/** The essence of a Content-Type (`type/subtype`, lowercase), or undefined without one. */
function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

// zod-openapi's media gate counts application/x-www-form-urlencoded as the declared form type; this
// one runs first and lets only the four declared types through. The gate still answers 415 for a
// body without a Content-Type.
const certificateMediaType = createMiddleware<AppEnv>(async (c, next) => {
  const type = mediaType(c.req.header("Content-Type"));
  if (type !== undefined && !CERTIFICATE_MEDIA_TYPES.has(type)) {
    throw new ApiError(415, "unsupported_media_type", ERROR_MESSAGES.unsupported_media_type);
  }
  await next();
});

const binary = z.string().openapi({ format: "binary" });

// A file entry of a form is a File, so a Blob; a string field is not. (z.file() is typed with zod's
// own File stand-in in the Worker program.)
const CertificateUpload = z
  .object({ certificate: z.instanceof(Blob).openapi({ type: "string", format: "binary" }) })
  .openapi("CertificateUpload");

export const importCertificateRoute = createRoute({
  method: "post",
  path: "/admin/certificates",
  operationId: "importCertificate",
  summary: "Import a CA certificate",
  description:
    "DER or a single PEM block, as the raw body or as the file field `certificate` of a " +
    "multipart form; the format is recognized from the bytes. Importing does not authorize " +
    "anything: a certificate only issues CRLs once a config target names it. A PEM bundle is " +
    "rejected (`pem_blocks`): the CLI sends each block on its own.",
  security,
  middleware: [certificateMediaType],
  request: {
    body: {
      // Not required: with `required` the form validator would also run for the raw types.
      required: false,
      content: {
        "application/pkix-cert": { schema: binary },
        "application/x-pem-file": { schema: z.string() },
        "application/octet-stream": { schema: binary },
        [MULTIPART]: { schema: CertificateUpload },
      },
    },
  },
  responses: {
    200: {
      description: "Already imported: the stored entry, nothing was written",
      content: json(ImportedCertificate),
    },
    201: { description: "Imported", content: json(ImportedCertificate) },
    ...ADMIN_FAILURES,
    409: {
      description: "The catalog kept changing concurrently; retry",
      content: json(ConcurrentUpdateError),
    },
    413: PAYLOAD_TOO_LARGE,
    415: UNSUPPORTED_MEDIA_TYPE,
    422: {
      description: "Not a certificate this service accepts; `details.reason` says why",
      content: json(InvalidCertificateError),
    },
  },
});

// GET / PUT /admin/config ------------------------------------------------------------------------

export const getConfigRoute = createRoute({
  method: "get",
  path: "/admin/config",
  operationId: "getConfig",
  summary: "Read config.json",
  description:
    "The stored bytes as they are, also when an out-of-band write left them invalid (so that " +
    "they can be repaired). The ETag is the SHA-256 of those bytes, for `If-Match` on PUT.",
  security,
  responses: {
    200: { description: "The stored config.json", headers: ETAG, content: json(ConfigSchema) },
    404: { description: "Nothing has been configured yet", content: json(NotFoundError) },
    ...ADMIN_FAILURES,
  },
});

const STRONG_SHA256_ETAG = /^"([0-9a-f]{64})"$/;

/**
 * The precondition of PUT /admin/config (owner decision 4 of slice 2): exactly one of `If-Match`
 * or `If-None-Match: *`. Neither, both, or an If-None-Match other than `*` → 428
 * precondition_required. An If-Match that is not one strong ETag as GET sends it (`W/`, a list,
 * unquoted, `*`) can never match → 412; so can a well-formed one for another state (applyConfig).
 */
export function configPrecondition(headers: Headers): ConfigPrecondition {
  const ifMatch = headers.get("If-Match");
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifMatch === null && ifNoneMatch === "*") {
    return { ifNoneMatch: "*" };
  }
  if (ifMatch === null || ifNoneMatch !== null) {
    throw new ApiError(
      428,
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
    412,
    "precondition_failed",
    "The precondition does not hold for the stored configuration: GET it again"
  );
}

function configInvalid(issues: ConfigIssue[]): ApiError {
  return new ApiError(422, "config_invalid", "The configuration is invalid", { issues });
}

// 428 and the malformed-If-Match 412 come from the headers alone: answered before the body is
// parsed or validated.
const requirePrecondition = createMiddleware<AppEnv>(async (c, next) => {
  configPrecondition(c.req.raw.headers);
  await next();
});

export const applyConfigRoute = createRoute({
  method: "put",
  path: "/admin/config",
  operationId: "applyConfig",
  summary: "Replace config.json",
  description:
    "The whole configuration, checked against rules V1–V9 (every violation in " +
    '`details.issues`). Exactly one precondition: `If-Match: "<ETag>"` from GET, or ' +
    "`If-None-Match: *` for the first configuration.",
  security,
  middleware: [requirePrecondition],
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
    body: { required: true, content: json(ConfigSchema) },
  },
  responses: {
    200: {
      description: "Applied: the stored bytes and their new ETag",
      headers: ETAG,
      content: json(ConfigSchema),
    },
    ...ADMIN_FAILURES,
    412: {
      description: "The precondition does not hold (another apply came first, or W/ / list / *)",
      content: json(PreconditionFailedError),
    },
    413: PAYLOAD_TOO_LARGE,
    415: UNSUPPORTED_MEDIA_TYPE,
    422: {
      description: "The configuration breaks rules V1–V9",
      content: json(ConfigInvalidError),
    },
    428: {
      description: "Not exactly one of If-Match and If-None-Match: *",
      content: json(PreconditionRequiredError),
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
  const log = createLogger(deps);
  const admin = new OpenAPIHono<AppEnv>();

  admin.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    description: "AIA_ADMIN_TOKEN",
  });

  const token = deps.settings.adminToken;
  if (token === undefined) {
    admin.use(
      "/admin/*",
      createMiddleware<AppEnv>(async () => {
        throw new ApiError(
          503,
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
    let bytes: Uint8Array;
    if (mediaType(c.req.header("Content-Type")) === MULTIPART) {
      // Validated against CertificateUpload: exactly one field `certificate`, a file (a string
      // field is 400). Typed as the union of all four body schemas, hence the cast.
      const { certificate } = c.req.valid("form") as z.output<typeof CertificateUpload>;
      bytes = new Uint8Array(await certificate.arrayBuffer());
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    }
    if (bytes.byteLength === 0) {
      throw new ApiError(400, "bad_request", "Expected a certificate in the request body");
    }

    const result = await importCertificate(deps, bytes);
    if ("error" in result) {
      if (result.error === "invalid_certificate") {
        log({ level: "warn", msg: "import", reason: result.details.reason });
        throw new ApiError(
          422,
          "invalid_certificate",
          "Not a valid X.509 certificate",
          result.details
        );
      }
      log({ level: "warn", msg: "import", certificateId: result.id, reason: result.error });
      throw new ApiError(
        409,
        "concurrent_update",
        "The catalog kept changing concurrently: retry the import"
      );
    }
    log({ level: "info", msg: "import", certificateId: result.id, outcome: result.outcome });
    const { size, importedAt, summary } = result.entry;
    const body = { outcome: result.outcome, id: result.id, size, importedAt, summary };
    return result.outcome === "created" ? c.json(body, 201, NO_STORE) : c.json(body, 200, NO_STORE);
  });

  admin.openapi(getConfigRoute, async () => {
    const stored = await deps.store.get(CONFIG_KEY);
    if (stored === null) {
      throw new ApiError(404, "not_found", "Nothing has been configured yet");
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
    // ConfigSchema validates the body before the handler runs: its failure is config_invalid
    // (rule V1, as from applyConfig), not the default 400.
    (result, c) => {
      if (result.success) {
        return undefined;
      }
      if (result.target !== "json") {
        throw validationError(result.target, result.error);
      }
      // No Content-Type: the media gate let the request through only because it has no body, and
      // the validator checked a placeholder `{}`.
      if (c.req.header("Content-Type") === undefined) {
        throw new ApiError(400, "bad_request", "Expected a JSON body");
      }
      throw configInvalid(schemaIssues(result.error));
    }
  );

  return admin;
}
