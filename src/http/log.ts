// Structured logging (implementation §2.6, plan §4.3). Every line goes through deps.log as one JSON
// object with `level` and `msg` (an event name); AIA_LOG_FORMAT=pretty lays the same fields out as
// one line of text. Never log tokens, request bodies, headers or query strings.
import { createMiddleware } from "hono/factory";
import type { AppDeps, AppEnv, AppSettings, ClientIpHeader } from "./types.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type Logger = (record: LogRecord) => void;

// A bare value in pretty output: printable ASCII other than space, `"` and `=`. Anything else is
// JSON-encoded, which escapes C0 controls and line breaks; DEL, C1 controls and U+2028 / U+2029 are
// escaped on top. The path is request-controlled, so raw ESC / BEL / CSI must never reach the
// operator's terminal (CWE-150).
const BARE = /^[!#-<>-~]+$/;
const UNSAFE = /[\u007f-\u009f\u2028\u2029]/g;

function prettyValue(value: unknown): string {
  if (typeof value === "string" && BARE.test(value)) {
    return value;
  }
  return JSON.stringify(value).replace(
    UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** One line: the JSON object, or `LEVEL msg key=value …` for humans. */
export function formatLogLine(format: AppSettings["logFormat"], record: LogRecord): string {
  if (format === "json") {
    return JSON.stringify(record);
  }
  const { level, msg, ...fields } = record;
  const parts = [level.toUpperCase(), msg];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      parts.push(`${key}=${prettyValue(value)}`);
    }
  }
  return parts.join(" ");
}

export function createLogger(deps: Pick<AppDeps, "log" | "settings">): Logger {
  return (record) => {
    deps.log(formatLogLine(deps.settings.logFormat, record));
  };
}

/** Loggable summary of a thrown value. The stack only when asked (unexpected errors). */
export function describeError(
  error: unknown,
  options: { stack?: boolean } = {}
): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return options.stack && error.stack !== undefined
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: error.name, message: error.message };
  }
  return { name: typeof error, message: String(error) };
}

const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

/** An IPv4 (dotted quad) or IPv6 literal: no port, brackets, zone or surrounding text. */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) {
    return true;
  }
  // IPv6: the WHATWG URL host parser (every runtime has it) implements the full RFC 4291 grammar.
  return /^[0-9A-Fa-f:.]{2,45}$/.test(value) && URL.canParse(`http://[${value}]/`);
}

/**
 * The client address for the request log (only when trustProxy is set): CF-Connecting-IP as a
 * whole, or the right-most X-Forwarded-For entry (several header lines are joined with `, `).
 * Anything that is not an IP literal is dropped, never logged.
 */
function clientAddress(headers: Headers, header: ClientIpHeader): string | undefined {
  const value = headers.get(header);
  if (value === null) {
    return undefined;
  }
  const address = (
    header === "x-forwarded-for" ? value.slice(value.lastIndexOf(",") + 1) : value
  ).trim();
  return isIpAddress(address) ? address : undefined;
}

/**
 * Exactly one `request` line per request, written after `next()`: it runs outside
 * methodNotAllowed and onError, so it records the final status (405, the 500 envelope, …).
 * `path` is `c.req.path`, without the query string. `log` is the structured logger of
 * createLogger, not deps.log.
 */
export function requestLog(deps: Pick<AppDeps, "settings" | "clientIpHeader">, log: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const start = performance.now();
    await next();
    const client = deps.settings.trustProxy
      ? clientAddress(c.req.raw.headers, deps.clientIpHeader)
      : undefined;
    log({
      level: "info",
      msg: "request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - start) * 10) / 10,
      ...(client === undefined ? {} : { client }),
    });
  });
}
