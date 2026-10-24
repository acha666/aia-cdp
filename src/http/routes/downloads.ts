// Download routes (plan §6): `/ca/*`, `/crl/*` and `/dcrl/*` serve what the current config's path
// table and the catalog name (src/core/resources.ts), DER as stored and PEM derived on read. A
// plain Hono sub-app: not in the OpenAPI document, not part of AppType. HEAD comes with each GET
// route; other methods get onMethodNotAllowed's text/plain 405.
//
// The request path is looked up in the path table and never used as a store key; it is
// `c.req.path`, Hono's decodeURI form, and is not decoded again. If-None-Match is compared by hand
// before the blob is read (hono/etag compares after the handler), and HEAD does not read the
// object. Range is ignored: always a full 200.
import { Hono } from "hono";
import type { Context } from "hono";
import { readState } from "../../core/catalog.ts";
import { derToPem } from "../../core/pki/pem.ts";
import { downloadHeaders, ifNoneMatchHit, pemKind, resolveDownload } from "../../core/resources.ts";
import { readBlob } from "../../core/store.ts";
import type { AppDeps } from "../types.ts";
import { textNotFound } from "../ui.ts";

/** Registered for GET (and so HEAD). Hono's `/ca/*` also matches `/ca` itself. */
export const DOWNLOAD_ROUTES = ["/ca/*", "/crl/*", "/dcrl/*"] as const;

/**
 * One download request, in this order:
 *
 * 1. config.json and catalog.json, one `get` each: a missing config.json is an empty path table,
 *    an invalid one (or catalog.json) throws, which is a 500.
 * 2. not_found → text/plain 404, no-store; inconsistent → a thrown Error, the generic 500.
 * 3. If-None-Match hit → 304 with ETag and Cache-Control only (RFC 9110 §15.4.5).
 * 4. HEAD → 200 with every header, Content-Length from the catalog; the blob is not read.
 * 5. GET → the blob: missing → a thrown Error, the generic 500 (a 404 would hide a broken store).
 *    DER as stored, PEM as derToPem of it; Content-Length is the length of the body sent.
 *
 * Every 200 sets Content-Type itself: left unset, a GET reached a Node socket as text/plain while
 * the HEAD had none.
 */
async function serveDownload(c: Context, deps: AppDeps): Promise<Response> {
  const path = c.req.path;
  const { config, catalog } = await readState(deps.store);
  const resolution = resolveDownload(config, catalog, path);
  if (resolution.status === "not_found") {
    return textNotFound(c);
  }
  if (resolution.status === "inconsistent") {
    throw new Error(`The store cannot back the path entry ${JSON.stringify(resolution.reference)}`);
  }

  const headers = downloadHeaders(resolution, deps.now());
  if (ifNoneMatchHit(c.req.header("If-None-Match"), headers.ETag)) {
    return c.body(null, 304, { ETag: headers.ETag, "Cache-Control": headers["Cache-Control"] });
  }
  if (c.req.method === "HEAD") {
    return c.body(null, 200, { ...headers });
  }

  const der = await readBlob(deps.store, resolution.key);
  let body = der;
  if (resolution.format === "pem") {
    const pem = derToPem(der, pemKind(resolution.kind));
    // encode() returns a new ArrayBuffer-backed array; the Workers types only say Uint8Array.
    body = new TextEncoder().encode(pem) as Uint8Array<ArrayBuffer>;
  }
  return c.body(body, 200, { ...headers, "Content-Length": String(body.byteLength) });
}

export function downloadRoutes(deps: AppDeps) {
  const downloads = new Hono();
  for (const path of DOWNLOAD_ROUTES) {
    downloads.get(path, (c) => serveDownload(c, deps));
  }
  return downloads;
}
