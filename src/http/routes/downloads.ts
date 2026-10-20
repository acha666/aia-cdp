// Download routes (plan §6, implementation slice 3 steps 4–5): `/ca/*`, `/crl/*` and `/dcrl/*`
// serve what the current config's path table and the catalog name (src/core/resources.ts), DER as
// stored and PEM derived on read. A plain Hono sub-app: not in the OpenAPI document, not part of
// AppType. HEAD comes with each GET route; other methods get onMethodNotAllowed's text/plain 405.
//
// Rewrite of worker-aia-cdp@5b570aa:src/worker/worker.ts:47-84. The request path is looked up in
// the path table and never used as a store key (§10 #2); it is `c.req.path`, Hono's decodeURI
// form, and is not decoded again (M20). If-None-Match is compared by hand before the blob is read
// (B9: hono/etag compares after the handler), and HEAD no longer reads the object. Range is
// ignored: a full 200, as before.
import { Hono } from "hono";
import type { Context } from "hono";
import { readState } from "../../core/catalog.ts";
import { derToPem } from "../../core/pki/pem.ts";
import {
  downloadHeaders,
  ifNoneMatchHit,
  pemMarkers,
  resolveDownload,
} from "../../core/resources.ts";
import { ApiError, ERROR_MESSAGES } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import type { AppDeps, AppEnv } from "../types.ts";
import { textNotFound } from "../ui.ts";

/** Registered for GET (and so HEAD). Hono's `/ca/*` also matches `/ca` itself. */
export const DOWNLOAD_ROUTES = ["/ca/*", "/crl/*", "/dcrl/*"] as const;

// The store cannot back what config.json and catalog.json name. The caller logs the cause as its
// own event first; onError then writes the plain 500 envelope, with no further log line.
function storeInconsistency(): ApiError {
  return new ApiError(500, "internal", ERROR_MESSAGES.internal);
}

/**
 * One download request, in this order (slice 3 step 4):
 *
 * 1. config.json and catalog.json, one `get` each: a missing config.json is an empty path table,
 *    an invalid one (or catalog.json) throws, which is a 500.
 * 2. not_found → text/plain 404, no-store; inconsistent → `download_inconsistent`, 500.
 * 3. If-None-Match hit → 304 with ETag and Cache-Control only (RFC 9110 §15.4.5).
 * 4. HEAD → 200 with every header, Content-Length from the catalog; the blob is not read.
 * 5. GET → the blob: missing → `download_blob_missing`, another size than the catalog's →
 *    `download_size_mismatch`, both 500 (a 404 would hide a broken store). DER as stored, PEM as
 *    derToPem of it; Content-Length is the length of the body sent.
 *
 * Every 200 sets Content-Type itself: left unset, a GET reached a Node socket as text/plain while
 * the HEAD had none.
 */
async function serveDownload(c: Context<AppEnv>, deps: AppDeps, log: Logger): Promise<Response> {
  const path = c.req.path;
  const { config, catalog } = await readState(deps.store);
  const resolution = resolveDownload(config, catalog, path);
  if (resolution.status === "not_found") {
    return textNotFound(c);
  }
  if (resolution.status === "inconsistent") {
    log({ level: "error", msg: "download_inconsistent", path, ...resolution.reference });
    throw storeInconsistency();
  }

  const headers = downloadHeaders(resolution, deps.now());
  if (ifNoneMatchHit(c.req.header("If-None-Match"), headers.ETag)) {
    return c.body(null, 304, { ETag: headers.ETag, "Cache-Control": headers["Cache-Control"] });
  }
  if (c.req.method === "HEAD") {
    return c.body(null, 200, { ...headers });
  }

  const { key, size } = resolution;
  const object = await deps.store.get(key);
  if (object === null) {
    log({ level: "error", msg: "download_blob_missing", path, key });
    throw storeInconsistency();
  }
  const der = object.bytes;
  if (der.byteLength !== size) {
    log({ level: "error", msg: "download_size_mismatch", path, key, size, actual: der.byteLength });
    throw storeInconsistency();
  }
  let body = der;
  if (resolution.format === "pem") {
    const { begin, end } = pemMarkers(resolution.kind);
    // encode() returns a new ArrayBuffer-backed array; the Workers types only say Uint8Array.
    body = new TextEncoder().encode(derToPem(der, begin, end)) as Uint8Array<ArrayBuffer>;
  }
  return c.body(body, 200, { ...headers, "Content-Length": String(body.byteLength) });
}

export function downloadRoutes(deps: AppDeps) {
  const log = createLogger(deps);
  const downloads = new Hono<AppEnv>();
  for (const path of DOWNLOAD_ROUTES) {
    downloads.get(path, (c) => serveDownload(c, deps, log));
  }
  return downloads;
}
