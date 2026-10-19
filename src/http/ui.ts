// Reserved prefixes and the UI fallback (plan §4.4, implementation slice 1 step 4). Both runtimes
// share these rules: the Workers SPA asset layer and the Node static handler are only reached
// through deps.ui, so /api and download-prefix misses never become 200 HTML (C12).
import type { Context, NotFoundHandler } from "hono";
import { ERROR_MESSAGES, errorBody, NO_STORE } from "./errors.ts";
import type { AppDeps, AppEnv } from "./types.ts";

/** API paths: a miss is the JSON 404 envelope. */
export const API_PREFIX = /^\/api(?:\/|$)/;

/**
 * Download paths (CryptoAPI / OpenSSL clients): a miss is a text/plain 404. The trailing slash
 * matters: /crls/ and /certificates/ are UI routes.
 */
export const DOWNLOAD_PREFIX = /^\/(?:ca|crl|dcrl)\//;

/** Content-hashed Vite output. */
const HASHED_ASSETS = "/assets/";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The last path segment has a file extension (`/assets/x.js`, `/favicon.ico`, `/.env`). */
export function hasFileExtension(path: string): boolean {
  return /\.[^/]*$/.test(path.slice(path.lastIndexOf("/") + 1));
}

/** `text/plain` 404 `Not Found`, as served to download clients. */
export function textNotFound(c: Context<AppEnv>): Response {
  return c.text("Not Found", 404, NO_STORE);
}

function isHtml(res: Response): boolean {
  return res.headers.get("Content-Type")?.toLowerCase().startsWith("text/html") ?? false;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/**
 * app.notFound: every request no route answered.
 *
 * - `/api`, `/api/*` → JSON envelope 404 `not_found`, no-store.
 * - `/ca/*`, `/crl/*`, `/dcrl/*` → text/plain 404, no-store (405 on these prefixes is slice 3).
 * - other GET / HEAD → `deps.ui(req)`, copied (binding responses have immutable headers), with
 *   `/assets/*` immutable and everything else no-cache; a ui 404, or text/html for a path whose
 *   last segment has a non-.html extension (the SPA fallback for a missing file), → text 404.
 * - other methods, or no ui → text 404.
 *
 * A 404 on a registered path with another method becomes 405 in methodNotAllowed afterwards.
 */
export function uiFallback(deps: Pick<AppDeps, "ui">): NotFoundHandler<AppEnv> {
  return async (c) => {
    const path = c.req.path;
    if (API_PREFIX.test(path)) {
      return c.json(errorBody("not_found", ERROR_MESSAGES.not_found), 404, NO_STORE);
    }
    const method = c.req.method;
    if (
      DOWNLOAD_PREFIX.test(path) ||
      deps.ui === undefined ||
      (method !== "GET" && method !== "HEAD")
    ) {
      return textNotFound(c);
    }
    // HEAD is passed through as HEAD.
    const res = await deps.ui(c.req.raw);
    if (
      res.status === 404 ||
      (hasFileExtension(path) && !path.toLowerCase().endsWith(".html") && isHtml(res))
    ) {
      await discard(res);
      return textNotFound(c);
    }
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", path.startsWith(HASHED_ASSETS) ? IMMUTABLE : "no-cache");
    // A 304 passes through with the rewritten headers.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
