// Structured logging (implementation §2.6, plan §4.3). Every line goes through deps.log as one JSON
// object with `level` and `msg` (an event name); AIA_LOG_FORMAT=pretty lays the same fields out as
// one line of text. Never log tokens, request bodies, headers or query strings.
import { createMiddleware } from "hono/factory";
import type { AppDeps, AppEnv, AppSettings } from "./types.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type Logger = (record: LogRecord) => void;

// A bare value in pretty output: anything else is JSON-quoted, which also escapes line breaks.
const BARE = /^[^\s"=]+$/;

function prettyValue(value: unknown): string {
  return typeof value === "string" && BARE.test(value) ? value : JSON.stringify(value);
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

/** CF-Connecting-IP, else the first X-Forwarded-For entry. Only used when trustProxy is set. */
function clientAddress(headers: Headers): string | undefined {
  const address = (
    headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]
  )?.trim();
  return address === "" ? undefined : address;
}

/**
 * Exactly one `request` line per request, written after `next()`: it runs outside
 * methodNotAllowed and onError, so it records the final status (405, the 500 envelope, …).
 * `path` is `c.req.path`, without the query string.
 */
export function requestLog(settings: AppSettings, log: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const start = performance.now();
    await next();
    const client = settings.trustProxy ? clientAddress(c.req.raw.headers) : undefined;
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
