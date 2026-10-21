// CRL targets (plan §7.1): the upload POST /api/v1/crls (implementation slice 4 step 8) hands one
// CRL to publishCrl (src/core/publish.ts) and maps its result; GET /api/v1/crls and
// /api/v1/crls/{targetId} (slice 5a step 7) are the target views of src/core/views.ts. Public
// routes, so this sub-app joins the AppType chain (slice 5a step 8). The upload is a rewrite of
// worker-aia-cdp@5b570aa:src/worker/api/v2/crls/upload.ts:27-31, 184-203: raw bodies besides
// multipart, a string field, and the format recognized from the bytes (M8, §10 #13). The reads
// replace src/worker/api/v2/crls/{list,detail}.ts: one item per configured target (id = target
// UUID, never a store key, §10 #2), every revoked entry in the detail, no pagination or include=.
//
// Route middleware runs before zod-openapi's media gate and form validator, in this order:
// bearerAuth while AIA_UPLOAD_TOKEN is set (a missing or wrong token is 401 + WWW-Authenticate, a
// malformed Authorization header 400; unset, uploads need no token, §10 #19); the media type gate
// (415 with details); bodyLimit (AIA_MAX_UPLOAD_BYTES, 413, also for a streamed body without
// Content-Length). So an anonymous client never gets its body read, nor a 413 that tells it the
// limit. Failures are thrown as ApiError / HTTPException (and, for the reads, ReadInconsistencyError
// and store errors): onError writes every envelope (no-store), and the handlers only return
// successes. HEAD of the reads is Hono's automatic HEAD of each GET.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { readState } from "../../core/catalog.ts";
import { publishCrl } from "../../core/publish.ts";
import type { PublishErrorCode, PublishFailure } from "../../core/publish.ts";
import { crlTargetDetail, crlTargetList, findCrlTarget } from "../../core/views.ts";
import { ApiError, NO_STORE } from "../errors.ts";
import { createLogger } from "../log.ts";
import { mediaType, MULTIPART } from "../media.ts";
import {
  BadRequestError,
  CRL_MEDIA_TYPES,
  CrlConflictError,
  CrlMediaTypeError,
  CrlRejectedError,
  CrlTargetDetail,
  CrlTargetListItem,
  CrlUpload,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  PublishedCrl,
  TargetIdParam,
  UnauthorizedError,
} from "../schemas.ts";
import type { AppDeps, AppEnv, AppSettings } from "../types.ts";

const SECURITY_SCHEME = "uploadBearer";

// Anonymous (`{}`) while AIA_UPLOAD_TOKEN is unset, the bearer token once it is set. Typed: an
// inferred union of the two element shapes would make createRoute lose the route's literal types.
const security: Record<string, string[]>[] = [{}, { [SECURITY_SCHEME]: [] }];

function json<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

const binary = z.string().openapi({ format: "binary" });

const TAGS = ["crls"];

const ACCEPTED: ReadonlySet<string> = new Set(CRL_MEDIA_TYPES);

// The multipart Content-Type that hono/validator parses as a form (its multipartRegex): at most a
// boundary parameter. zod-openapi's media gate answers any other one 415 without details, so such a
// type stops here as a malformed multipart request.
const FORM_CONTENT_TYPE = /^multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?$/i;

// Parameters and case are ignored (M8). zod-openapi's gate would count
// application/x-www-form-urlencoded as the declared form type and let a missing Content-Type
// through without a body; this one only takes the four declared types.
const crlMediaType = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Content-Type");
  // An empty Content-Type header is none.
  const type = header === undefined || header.trim() === "" ? undefined : mediaType(header);
  if (type === undefined || !ACCEPTED.has(type)) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Send the CRL as multipart/form-data (field crl), application/pkix-crl, " +
        "application/x-pem-file or application/octet-stream",
      { received: type ?? null, accepted: CRL_MEDIA_TYPES }
    );
  }
  if (type === MULTIPART && !FORM_CONTENT_TYPE.test(header ?? "")) {
    throw new ApiError(
      400,
      "bad_request",
      "Malformed multipart/form-data Content-Type: expected only a boundary parameter"
    );
  }
  await next();
});

/** The route middleware, in the order of the file comment. */
function uploadGate(settings: AppSettings): MiddlewareHandler[] {
  const token = settings.uploadToken;
  return [
    ...(token === undefined ? [] : [bearerAuth({ token })]),
    crlMediaType,
    bodyLimit({ maxSize: settings.maxUploadBytes }),
  ];
}

export function uploadCrlRoute(settings: AppSettings) {
  return createRoute({
    method: "post",
    path: "/crls",
    operationId: "uploadCrl",
    summary: "Publish a CRL",
    description:
      "One CRL, DER or a single X509 CRL PEM block, as the raw body or as the field `crl` of a " +
      "multipart form (a file, or PEM text); the format is recognized from the bytes. It goes " +
      "to the target that the configuration binds to its issuer (found by the Authority Key " +
      "Identifier) and its kind (full or delta), once the extension policy, the issuer's " +
      "signature and the comparison with the target's current CRL accept it. " +
      "`Authorization: Bearer <AIA_UPLOAD_TOKEN>` is needed only while that token is set.",
    tags: TAGS,
    security,
    middleware: uploadGate(settings),
    request: {
      body: {
        // Not required: with `required` the form validator would also run for the raw types.
        required: false,
        content: {
          [MULTIPART]: { schema: CrlUpload },
          "application/pkix-crl": { schema: binary },
          "application/x-pem-file": { schema: z.string() },
          "application/octet-stream": { schema: binary },
        },
      },
    },
    responses: {
      200: {
        description: "Updated; or `unchanged`: the same bytes are current, nothing was written",
        content: json(PublishedCrl),
      },
      201: {
        description: "Published to a target without a current CRL",
        content: json(PublishedCrl),
      },
      400: {
        description:
          "A malformed Authorization header; the field `crl` missing, repeated or empty; an " +
          "empty body; or a malformed multipart body",
        content: json(BadRequestError),
      },
      401: {
        description: "AIA_UPLOAD_TOKEN is set, and the token is missing or wrong",
        headers: z.object({ "WWW-Authenticate": z.string() }),
        content: json(UnauthorizedError),
      },
      409: {
        description:
          "Not newer than the target's current CRL (`details.current`): stale_crl, conflict " +
          "(other bytes for the same CRL Number and thisUpdate) or non_orderable (a CRL Number " +
          "on one side only); or concurrent_update (the catalog kept changing: retry)",
        content: json(CrlConflictError),
      },
      413: {
        description: "The body is larger than AIA_MAX_UPLOAD_BYTES",
        content: json(PayloadTooLargeError),
      },
      415: {
        description: "The Content-Type is missing or not one of the request body's media types",
        content: json(CrlMediaTypeError),
      },
      422: {
        description: "Not a CRL this service publishes: the code and `details` say why",
        content: json(CrlRejectedError),
      },
      500: {
        description: "The store failed (the error is logged, never sent); retry later",
        content: json(InternalError),
      },
    },
  });
}

// Reads -----------------------------------------------------------------------------------------

const READ_INTERNAL = {
  description:
    "The store failed, or it cannot back what catalog.json and config.json name (logged, never " +
    "sent); retry later",
  content: json(InternalError),
};

export const listCrlTargetsRoute = createRoute({
  method: "get",
  path: "/crls",
  operationId: "listCrlTargets",
  summary: "List CRL targets",
  description:
    "Every target config.json defines, in targetId order, with its kind, label, issuer, download " +
    "paths and current CRL summary (`current: null` while nothing is published). The whole " +
    "list: no pagination.",
  tags: TAGS,
  responses: {
    200: { description: "The targets", content: json(CrlTargetListItem.array()) },
    500: READ_INTERNAL,
  },
});

export const getCrlTargetRoute = createRoute({
  method: "get",
  path: "/crls/{targetId}",
  operationId: "getCrlTarget",
  summary: "Get a CRL target",
  description:
    "The list item, and for a published target its current CRL decoded: verifier, fingerprints, " +
    "TBSCertList with every revoked entry and extension, signature algorithm with its " +
    "parameters and signature value. An unpublished target is a 200 with `current: null`.",
  tags: TAGS,
  request: { params: TargetIdParam },
  responses: {
    200: { description: "The target", content: json(CrlTargetDetail) },
    400: { description: "The target id is not a UUID", content: json(BadRequestError) },
    404: {
      description: "config.json defines no target with this id",
      content: json(NotFoundError),
    },
    500: READ_INTERNAL,
  },
});

// Failures --------------------------------------------------------------------------------------

const CONFLICTS: ReadonlySet<PublishErrorCode> = new Set<PublishErrorCode>([
  "stale_crl",
  "conflict",
  "non_orderable",
  "concurrent_update",
]);

const MESSAGES = {
  invalid_crl: "Not a valid X.509 CRL",
  not_yet_valid: "The CRL's thisUpdate is more than 5 minutes ahead of the service's clock",
  unknown_critical_extension: "The CRL has a critical extension this service does not know",
  scoped_crl_unsupported: "Scoped and indirect CRLs are not supported",
  unsupported_algorithm: "The CRL's signature algorithm is not supported",
  issuer_not_found:
    "No imported certificate has the CRL's Authority Key Identifier as its Subject Key Identifier",
  target_not_configured: "No configured target of the CRL's kind names its issuer",
  invalid_signature: "The CRL's signature does not verify with the issuer's key",
  stale_crl: "The CRL is older than the target's current CRL",
  conflict: "The target's current CRL has other bytes for the same CRL Number and thisUpdate",
  non_orderable: "Only one of the CRL and the target's current CRL has a CRL Number",
  concurrent_update: "The catalog kept changing concurrently: retry the upload",
} as const satisfies Record<PublishErrorCode, string>;

/** 409 for the four conflicts, 422 for every other failure; details as publishCrl gives them. */
function publishError(failure: PublishFailure): ApiError {
  const status = CONFLICTS.has(failure.error) ? 409 : 422;
  if (failure.error === "concurrent_update") {
    return new ApiError(status, failure.error, MESSAGES[failure.error]);
  }
  const message =
    failure.error === "issuer_not_found" && "reason" in failure.details
      ? "The CRL has no Authority Key Identifier keyIdentifier"
      : MESSAGES[failure.error];
  return new ApiError(status, failure.error, message, failure.details);
}

// Body ------------------------------------------------------------------------------------------

/**
 * The uploaded bytes. Multipart: the field `crl` that the form validator checked (exactly once, a
 * file or a string); parseBody returns the form Hono parsed for it. A string field is its UTF-8
 * text (pasted PEM). Raw types: the body as it is. The format is left to publishCrl.
 */
async function uploadedBytes(c: Context<AppEnv>): Promise<Uint8Array> {
  if (mediaType(c.req.header("Content-Type")) !== MULTIPART) {
    return new Uint8Array(await c.req.arrayBuffer());
  }
  const { crl } = await c.req.parseBody();
  if (typeof crl === "string") {
    return new TextEncoder().encode(crl);
  }
  if (crl instanceof Blob) {
    return new Uint8Array(await crl.arrayBuffer());
  }
  // Not reached: the validator answered 400 already.
  throw new ApiError(400, "bad_request", "Expected the field crl");
}

// Sub-app ---------------------------------------------------------------------------------------

export function crlRoutes(deps: AppDeps) {
  const log = createLogger(deps);
  const crls = new OpenAPIHono<AppEnv>();

  crls.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    description: "AIA_UPLOAD_TOKEN (optional: while it is unset, uploads need no token)",
  });

  return crls
    .openapi(listCrlTargetsRoute, async (c) => {
      const { config, catalog } = await readState(deps.store);
      return c.json(crlTargetList(config, catalog), 200, NO_STORE);
    })
    .openapi(getCrlTargetRoute, async (c) => {
      const { targetId } = c.req.valid("param");
      const { config, catalog } = await readState(deps.store);
      const source = findCrlTarget(config, catalog, targetId);
      if (source === undefined) {
        throw new ApiError(404, "not_found", "No target with this id is configured");
      }
      // An unpublished target reads no blob.
      const blob = source.current === null ? null : await deps.store.get(source.current.key);
      return c.json(await crlTargetDetail(source, blob?.bytes ?? null), 200, NO_STORE);
    })
    .openapi(uploadCrlRoute(deps.settings), async (c) => {
      const bytes = await uploadedBytes(c);
      if (bytes.byteLength === 0) {
        throw new ApiError(400, "bad_request", "Expected a CRL, but the upload is empty");
      }
      // Logs the call's one `publish` line, also when it throws (then onError's 500).
      const result = await publishCrl(
        { store: deps.store, now: deps.now, sleep: deps.sleep, log },
        bytes
      );
      if ("error" in result) {
        throw publishError(result);
      }
      const { outcome, targetId, kind, issuer, current, downloads } = result;
      const { crlNumber, baseCrlNumber, thisUpdate, nextUpdate } = current.summary;
      const body = {
        outcome,
        target: targetId,
        kind,
        sha256: current.sha256,
        crlNumber,
        baseCrlNumber,
        thisUpdate,
        nextUpdate,
        issuer,
        downloads,
      };
      return outcome === "created" ? c.json(body, 201, NO_STORE) : c.json(body, 200, NO_STORE);
    });
}
