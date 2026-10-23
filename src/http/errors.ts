// Error envelope and handlers (plan §7.3, implementation §2.6): a success body is the resource
// itself, a failure is one envelope `{ error: { code, message, details? } }`, and exception text
// never reaches a response.
import type { Hook, z } from "@hono/zod-openapi";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError } from "./log.ts";
import type { Logger } from "./log.ts";
import type { ErrorCode } from "./schemas.ts";
import type { AppEnv } from "./types.ts";

export interface ErrorBody<C extends ErrorCode = ErrorCode> {
  error: { code: C; message: string; details?: unknown };
}

/** Generic in the code, so the body satisfies a route's per-status schema with a narrowed enum. */
export function errorBody<C extends ErrorCode>(
  code: C,
  message: string,
  details?: unknown
): ErrorBody<C> {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Our own fixed texts for errors raised by the framework or by unexpected failures. */
export const ERROR_MESSAGES = {
  bad_request: "Bad request",
  unauthorized: "Unauthorized",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  conflict: "Conflict",
  precondition_failed: "Precondition failed",
  precondition_required: "Precondition required",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  internal: "Internal server error",
} as const satisfies Partial<Record<ErrorCode, string>>;

/** API JSON, including every error, is never cached (implementation §2.6). */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Thrown by http/core code for expected failures; mapped 1:1 onto the envelope by onError. */
export class ApiError extends Error {
  // erasableSyntaxOnly: explicit fields instead of constructor parameter properties.
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Error code for an HTTPException thrown by Hono middleware (bearerAuth, bodyLimit, …). */
const CODE_BY_STATUS: Partial<Record<number, keyof typeof ERROR_MESSAGES>> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  412: "precondition_failed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  428: "precondition_required",
};

// Headers of a library HTTPException response that must survive the envelope rewrite: bearerAuth
// sets WWW-Authenticate; a thrown 405 / 503 may carry Allow / Retry-After.
const PRESERVED_HEADERS = ["WWW-Authenticate", "Allow", "Retry-After"] as const;

export function createErrorHandler(log: Logger): ErrorHandler<AppEnv> {
  const logUnexpected = (err: Error, c: Context<AppEnv>) => {
    log({
      level: "error",
      msg: "unhandled_error",
      method: c.req.method,
      path: c.req.path,
      error: describeError(err, { stack: true }),
    });
  };
  return (err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), err.status, NO_STORE);
    }
    if (err instanceof HTTPException) {
      const code = CODE_BY_STATUS[err.status] ?? (err.status >= 500 ? "internal" : "bad_request");
      if (code === "internal") {
        logUnexpected(err, c);
      }
      const headers: Record<string, string> = { ...NO_STORE };
      const res = err.getResponse();
      for (const name of PRESERVED_HEADERS) {
        const value = res.headers.get(name);
        if (value !== null) {
          headers[name] = value;
        }
      }
      // The library's message is not part of the contract: use our own text.
      return c.json(errorBody(code, ERROR_MESSAGES[code]), err.status, headers);
    }
    // Unexpected: the stack goes to the log, never to the client.
    logUnexpected(err, c);
    return c.json(errorBody("internal", ERROR_MESSAGES.internal), 500, NO_STORE);
  };
}

/** 400 bad_request for a zod validation failure, with the target and the issues. */
export function validationError(target: string, error: z.ZodError): ApiError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code,
    message: issue.message,
  }));
  return new ApiError(400, "bad_request", "Request validation failed", { target, issues });
}

/**
 * OpenAPIHono defaultHook: a zod validation failure throws validationError, so onError writes the
 * envelope. Thrown rather than returned so that a route-level hook can delegate to it without
 * widening its typed responses.
 */
export const validationHook: Hook<unknown, AppEnv, string, undefined> = (result) => {
  if (!result.success) {
    throw validationError(result.target, result.error);
  }
  return undefined;
};
