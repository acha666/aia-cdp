// Structured logging (implementation §2.6, plan §4.3). Every line goes through deps.log as one JSON
// object with `level` and `msg` (an event name). Never log tokens, request bodies, headers or
// query strings.
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "./types.ts";

type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type Logger = (record: LogRecord) => void;

export function createLogger(deps: Pick<AppDeps, "log">): Logger {
  return (record) => {
    deps.log(JSON.stringify(record));
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

/**
 * Exactly one `request` line per request, written after `next()`: it runs outside
 * methodNotAllowed and onError, so it records the final status (405, the 500 envelope, …).
 * `path` is `c.req.path`, without the query string. `log` is the structured logger of
 * createLogger, not deps.log.
 */
export function requestLog(log: Logger) {
  return createMiddleware(async (c, next) => {
    const start = performance.now();
    await next();
    log({
      level: "info",
      msg: "request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - start) * 10) / 10,
    });
  });
}
