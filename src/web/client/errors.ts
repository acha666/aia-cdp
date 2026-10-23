// Failures of API calls as one error type. A success body is returned as the server sent it (no
// envelope to unpack, no zod at run time), typed by hc from the route's schema; every failure is
// an ApiError, whose `code` the UI maps to a message.
//
// Where each code comes from:
// - a v1 code (src/http/schemas.ts, or one this build does not know yet): unwrap, from the envelope
//   `{ error: { code, message, details? } }` of a non-2xx response; `status` is the HTTP status.
// - invalid_response: unwrap, when the body is not JSON (a proxy's HTML page, an empty body) or a
//   non-2xx JSON body is not the envelope; `status` is the HTTP status.
// - network: apiFetch (the `fetch` of the hc client in api.ts) when fetch rejects, and unwrap when
//   reading the body fails; `status` is 0, as for Response.error(). So a request through `api`
//   that gets no response fails with an ApiError whether or not it goes through unwrap. An abort
//   is not a failure: it keeps its own error (TanStack Query cancels queries through the signal).

/** A failed API call. Thrown by unwrap and by the client's fetch (api.ts). */
export class ApiError extends Error {
  // erasableSyntaxOnly: explicit fields instead of constructor parameter properties.
  /** A v1 code, `network` or `invalid_response`, or a code of a newer server. */
  readonly code: string;
  /** The HTTP status; 0 for `network` (no response). */
  readonly status: number;
  /** The envelope's `details`, as sent. */
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** What unwrap needs of a response: a plain Response or hc's ClientResponse. */
type ResponseLike = Pick<Response, "ok" | "status" | "text">;

/** The body types of the 2xx members of an hc response union (ok: true). */
type SuccessBody<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

/**
 * A response's JSON body when the status is 2xx; otherwise throws ApiError with the envelope's code
 * and the HTTP status. The body is not validated beyond the envelope's shape: the server's schemas
 * (and the OpenAPI document) are the contract, and hc types the result from them.
 */
export async function unwrap<R extends ResponseLike>(res: R): Promise<SuccessBody<R>> {
  const body = await readJson(res);
  if (res.ok) {
    return body as SuccessBody<R>;
  }
  const error = envelopeError(body);
  if (error === undefined) {
    throw invalidResponse(res.status);
  }
  throw new ApiError(res.status, error.code, error.message, error.details);
}

/**
 * The `fetch` of the hc client (api.ts): calls the global fetch at call time, and turns a request
 * that gets no response (offline, DNS, connection refused or reset, CORS) into ApiError `network`.
 */
export const apiFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw noResponse(error, init?.signal);
  }
};

async function readJson(res: ResponseLike): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw noResponse(error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(res.status);
  }
}

function envelopeError(
  body: unknown
): { code: string; message: string; details: unknown } | undefined {
  const error = (
    body as { error?: { code?: unknown; message?: unknown; details?: unknown } | null } | null
  )?.error;
  return typeof error?.code === "string" && typeof error.message === "string"
    ? { code: error.code, message: error.message, details: error.details }
    : undefined;
}

function invalidResponse(status: number): ApiError {
  return new ApiError(status, "invalid_response", "The response is not the API's JSON");
}

/** ApiError `network` for a request or body read that failed; an abort stays as it is. */
function noResponse(error: unknown, signal?: AbortSignal | null): unknown {
  if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
    return error;
  }
  return new ApiError(0, "network", "No response from the server", undefined, { cause: error });
}
