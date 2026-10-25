// The aia CLI's shared pieces and its access to the service: the base URL, the command's bearer
// token and the rule for sending it, requests with a timeout, and the error envelope.

export interface CliIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Readonly<Record<string, string | undefined>>;
  /** Each call receives finished text, newlines included. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** Wrong arguments or settings: exit 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The operation failed; the message is printed as is: exit 1. */
export class Failure extends Error {
  override name = "Failure";
}

export interface Context {
  io: CliIo;
  json: boolean;
  /** --url, else AIA_URL. */
  url: string | undefined;
  /** --token-file: wins over both variables of the command's token. */
  tokenFile: string | undefined;
  /** --allow-insecure-http: a token may go over http:// to any host. */
  allowInsecureHttp: boolean;
  /** --out: only for history <targetId> <sha256>. */
  out: string | undefined;
}

/** io.readFile; a file that cannot be read throws `fail(reason)`. */
export async function readBytes(
  io: CliIo,
  file: string,
  fail: (reason: string) => Error
): Promise<Uint8Array> {
  try {
    return await io.readFile(file);
  } catch (error) {
    throw fail(reasonOf(error));
  }
}

export function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  // fetch rejects with "fetch failed" and the socket error as its cause.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

// Service access ---------------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// RFC 6750 b64token, as the service requires of AIA_ADMIN_TOKEN (src/runtime/settings.ts). Checked
// here as well, because fetch rejects an invalid header value with a message that quotes it.
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

/** --url / AIA_URL, parsed: an http:// or https:// URL. */
function parsedServiceUrl(ctx: Context): URL {
  if (ctx.url === undefined || ctx.url === "") {
    throw new UsageError("no service URL: pass --url or set AIA_URL");
  }
  const url = URL.parse(ctx.url);
  if (url === null) {
    throw new UsageError("--url / AIA_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--url / AIA_URL must be an http:// or https:// URL");
  }
  return url;
}

/** The base URL without a trailing slash; a path prefix (behind a proxy) is kept. */
export function serviceUrl(ctx: Context): string {
  const url = parsedServiceUrl(ctx);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * localhost, 127.0.0.0/8 or [::1]: the Docker exec and development setups. The URL parser has
 * normalized the host already (127.1 → 127.0.0.1, [0:0:0:0:0:0:0:1] → [::1], case).
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
  );
}

/**
 * A token goes over https://, or over http:// to a loopback host, unless --allow-insecure-http.
 * The production host answers plain HTTP with no redirect (AIA / CDP clients need it), so
 * http://<host> reaches the service and would put the token on the wire in clear text.
 */
function checkTokenTransport(ctx: Context, name: string): void {
  const url = parsedServiceUrl(ctx);
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !ctx.allowInsecureHttp) {
    throw new UsageError(
      `refusing to send the ${name} token over http:// to ${url.host}: use https://, ` +
        "or pass --allow-insecure-http"
    );
  }
}

/** The admin token (import, config) or the upload token (publish). */
type TokenVariable = "AIA_ADMIN_TOKEN" | "AIA_UPLOAD_TOKEN";

const TOKEN_NAMES: Record<TokenVariable, string> = {
  AIA_ADMIN_TOKEN: "admin",
  AIA_UPLOAD_TOKEN: "upload",
};

/**
 * The command's bearer token, from --token-file, else `<variable>_FILE`, else `<variable>`
 * (trimmed); undefined when none of them is set. Both variables set, an unreadable file, an
 * empty or malformed token, or a token that checkTokenTransport refuses is a usage error.
 * Messages name the source, never the token.
 */
export async function bearerToken(
  ctx: Context,
  variable: TokenVariable
): Promise<string | undefined> {
  const { env } = ctx.io;
  const name = TOKEN_NAMES[variable];
  const fileVariable = `${variable}_FILE`;
  const file = ctx.tokenFile ?? env[fileVariable];
  let token: string | undefined;
  let source: string;
  if (file !== undefined && file !== "") {
    if (ctx.tokenFile === undefined && env[variable] !== undefined) {
      throw new UsageError(`set either ${variable} or ${fileVariable}, not both`);
    }
    source = `the token file ${file}`;
    const fail = (reason: string) => new UsageError(`cannot read ${source}: ${reason}`);
    token = new TextDecoder().decode(await readBytes(ctx.io, file, fail)).trim();
  } else {
    source = variable;
    token = env[variable]?.trim();
  }
  if (token === "") {
    throw new UsageError(`the ${name} token in ${source} is empty`);
  }
  if (token !== undefined && !BEARER_TOKEN.test(token)) {
    throw new UsageError(
      `the ${name} token in ${source} has characters a bearer token cannot have ` +
        "(letters, digits and - . _ ~ + / only, optionally ending in =)"
    );
  }
  if (token !== undefined) {
    checkTokenTransport(ctx, name);
  }
  return token;
}

/** `Authorization` for the admin routes: the admin token is required. */
export async function adminHeaders(ctx: Context): Promise<Record<string, string>> {
  const token = await bearerToken(ctx, "AIA_ADMIN_TOKEN");
  if (token === undefined) {
    throw new UsageError(
      "no admin token: pass --token-file, or set AIA_ADMIN_TOKEN_FILE or AIA_ADMIN_TOKEN"
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** A response with its body read in full. */
interface Reply {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  bytes: Uint8Array;
  /** `bytes` as UTF-8, as Response.text() decodes them. */
  text: string;
}

/**
 * fetch with a timeout, and the whole body read: a request that gets no response, or a body that
 * fails after the headers (a reset connection, the timeout firing mid-body), is a Failure.
 */
export async function request(ctx: Context, url: string, init: RequestInit): Promise<Reply> {
  let res: Response;
  try {
    res = await ctx.io.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Failure(`cannot reach ${url}: ${reasonOf(error)}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    throw new Failure(`cannot read the response from ${url}: ${reasonOf(error)}`);
  }
  const { status, statusText, ok, headers } = res;
  return { status, statusText, ok, headers, bytes, text: new TextDecoder().decode(bytes) };
}

/** `reply`, if `ok` (by default: a 2xx status); otherwise its HTTP error is the Failure. */
export function accepted(reply: Reply, ok = reply.ok): Reply {
  if (!ok) {
    throw new Failure(describeHttp(httpError(reply)));
  }
  return reply;
}

/** A non-success response: the error envelope's fields, or the status line without one. */
export interface HttpError {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
}

export function httpError(reply: Reply): HttpError {
  try {
    const { error } = JSON.parse(reply.text) as { error?: Record<string, unknown> };
    if (typeof error?.code === "string" && typeof error.message === "string") {
      return {
        status: reply.status,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
  } catch {
    // Not an envelope (a proxy's page, say): fall through.
  }
  return { status: reply.status, message: reply.statusText || "unexpected response" };
}

export function describeHttp(error: HttpError): string {
  const details = error.details as { reason?: unknown } | undefined;
  const reason = typeof details?.reason === "string" ? ` (${details.reason})` : "";
  const code = error.code === undefined ? "" : ` ${error.code}`;
  return `HTTP ${error.status}${code}${reason}: ${error.message}`;
}

/** The JSON body of a success response; a body that is not JSON is a Failure. */
export function jsonOf(reply: Reply): unknown {
  try {
    return JSON.parse(reply.text) as unknown;
  } catch {
    throw new Failure(`HTTP ${reply.status}, but the body is not JSON`);
  }
}
