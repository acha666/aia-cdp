// What the UI says about a failed API call (implementation slice 5b steps 6–7): the message of its
// code, `errors.<code>`, for every code the client knows (error-codes.ts); a code it does not know
// (a newer server's) or a failure that is not an ApiError reads `errors.unknown` with that code.
import { CLIENT_ERROR_CODES, ERROR_CODES } from "@/client/error-codes";
import { ApiError } from "@/client/errors";

const KNOWN_CODES: ReadonlySet<string> = new Set([...ERROR_CODES, ...CLIENT_ERROR_CODES]);

type Translate = (key: string, named?: Record<string, unknown>) => string;

/** The code of a failure: ApiError's code, else the error's name. */
export function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown";
}

/** The message of `error` in the UI language. */
export function errorMessage(error: unknown, t: Translate): string {
  const code = errorCode(error);
  return KNOWN_CODES.has(code) ? t(`errors.${code}`) : t("errors.unknown", { code });
}

/** The API answered 404 `not_found`: the page's resource does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "not_found";
}
