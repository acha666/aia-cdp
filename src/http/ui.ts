// Reserved prefixes and the UI fallback (plan §4.4, implementation slice 1 step 4). Both runtimes
// share these rules: the Workers SPA asset layer and the Node static handler are only reached
// through deps.ui, so /api and download-prefix misses never become 200 HTML (C12).
import type { Context, NotFoundHandler } from "hono";
import { ERROR_MESSAGES, errorBody, NO_STORE } from "./errors.ts";
import type { AppDeps, AppEnv } from "./types.ts";

/** API paths: a miss is the JSON 404 envelope. */
export const API_PREFIX = /^\/api(?:\/|$)/;

/**
 * Download paths (CryptoAPI / OpenSSL clients): a miss is a text/plain 404. The bare prefix counts
 * (`/ca` is a download route since slice 3, so `//ca` must not reach the UI), but a `/` or the end
 * must follow it: /crls/ and /certificates/ are UI routes.
 */
export const DOWNLOAD_PREFIX = /^\/(?:ca|crl|dcrl)(?:\/|$)/;

/** Content-hashed Vite output. */
const HASHED_ASSETS = "/assets/";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Statuses of a stored asset (full, range, revalidated): the only ones cached as immutable. */
const ASSET_STATUSES = new Set([200, 206, 304]);

/** The last path segment has a file extension (`/assets/x.js`, `/favicon.ico`, `/.env`). */
export function hasFileExtension(path: string): boolean {
  return /\.[^/]*$/.test(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The path the reserved prefixes are matched against: `%2F` / `%2f` decoded and runs of `/`
 * collapsed, so `//api/v1/x`, `/api%2Fv1/x` and `/crl%2fx` count as reserved too (a base URL with
 * a trailing slash, a proxy that re-encodes slashes). Routing itself still sees the raw path.
 */
export function reservedPrefixPath(path: string): string {
  return path.replace(/%2f/gi, "/").replace(/\/{2,}/g, "/");
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
 * - `/ca`, `/crl`, `/dcrl` and below → text/plain 404, no-store. GET / HEAD on the routed spelling
 *   is answered by the download routes themselves; this catches the spellings no route matches
 *   (`/ca%2Fx`, `//crl/x`, `//ca`) and other methods. Both prefixes are matched on
 *   reservedPrefixPath(path).
 * - other GET / HEAD → `deps.ui(req)`, copied (binding responses have immutable headers); a ui
 *   404, or text/html for a path whose last segment has a non-.html extension (the SPA fallback
 *   for a missing file), → text 404. Cache-Control: immutable only for a file under /assets/
 *   (last segment with an extension) answered 200 / 206 / 304 and not as text/html; everything
 *   else no-cache, error statuses included (their status is kept).
 * - other methods, or no ui → text 404.
 *
 * A 404 on a registered path with another method becomes 405 in methodNotAllowed afterwards (text
 * on the download routes, the envelope elsewhere: errors.ts onMethodNotAllowed).
 */
export function uiFallback(deps: Pick<AppDeps, "ui">): NotFoundHandler<AppEnv> {
  return async (c) => {
    const path = c.req.path;
    const reserved = reservedPrefixPath(path);
    if (API_PREFIX.test(reserved)) {
      return c.json(errorBody("not_found", ERROR_MESSAGES.not_found), 404, NO_STORE);
    }
    const method = c.req.method;
    if (
      DOWNLOAD_PREFIX.test(reserved) ||
      deps.ui === undefined ||
      (method !== "GET" && method !== "HEAD")
    ) {
      return textNotFound(c);
    }
    // HEAD is passed through as HEAD.
    const res = await deps.ui(c.req.raw);
    const html = isHtml(res);
    if (
      res.status === 404 ||
      (hasFileExtension(path) && !path.toLowerCase().endsWith(".html") && html)
    ) {
      await discard(res);
      return textNotFound(c);
    }
    // Not for /assets/ or /assets/x (the SPA's index.html) or an error: a year is too long.
    const immutable =
      path.startsWith(HASHED_ASSETS) &&
      hasFileExtension(path) &&
      !html &&
      ASSET_STATUSES.has(res.status);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", immutable ? IMMUTABLE : "no-cache");
    // A 304 passes through with the rewritten headers.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
