// CRL targets (plan §7.1): the upload POST /api/v1/crls hands one CRL, the raw request body, to
// publishCrl (src/core/publish.ts) and maps its result; GET /api/v1/crls and
// /api/v1/crls/{targetId} are the target views of src/core/views.ts. Public routes, so this
// sub-app joins the AppType chain. The upload's format is recognized from the bytes. The reads
// list one item per configured target (id = target UUID, never a store key), every revoked entry
// in the detail, no pagination.
//
// The upload's route middleware, in this order: bearerAuth while AIA_UPLOAD_TOKEN is set (a
// missing or wrong token is 401 + WWW-Authenticate, a malformed Authorization header 400; unset,
// uploads need no token); the media type gate (415 with details); bodyLimit
// (AIA_MAX_UPLOAD_BYTES, 413, also for a streamed body without Content-Length). So an anonymous
// client never gets its body read, nor a 413 that tells it the limit. Failures are thrown as
// ApiError / HTTPException (and, for the reads, store errors): onError writes every envelope
// (no-store), and the handlers only return successes. HEAD of the reads is Hono's automatic HEAD
// of each GET.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { readState } from "../../core/catalog.ts";
import { publishCrl } from "../../core/publish.ts";
import type { PublishErrorCode, PublishFailure } from "../../core/publish.ts";
import { crlTargetDetail, crlTargetList, findCrlTarget } from "../../core/views.ts";
import { ApiError, NO_STORE } from "../errors.ts";
import { createLogger } from "../log.ts";
import { mediaTypeGate } from "../media.ts";
import {
  BadRequestError,
  CRL_MEDIA_TYPES,
  CrlConflictError,
  CrlMediaTypeError,
  CrlRejectedError,
  CrlTargetDetail,
  CrlTargetListItem,
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

const crlMediaType = mediaTypeGate(
  CRL_MEDIA_TYPES,
  "Send the CRL as application/pkix-crl, application/x-pem-file or application/octet-stream"
);

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
      "One CRL, DER or a single X509 CRL PEM block, as the request body; the format is " +
      "recognized from the bytes. It goes to the target that the configuration binds to its issuer (found by the Authority Key " +
      "Identifier) and its kind (full or delta), once the extension policy, the issuer's " +
      "signature and the comparison with the target's current CRL accept it. " +
      "`Authorization: Bearer <AIA_UPLOAD_TOKEN>` is needed only while that token is set.",
    tags: TAGS,
    security,
    middleware: uploadGate(settings),
    request: {
      body: {
        required: true,
        content: {
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
        description: "A malformed Authorization header, or an empty body",
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
      const bytes = new Uint8Array(await c.req.arrayBuffer());
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
