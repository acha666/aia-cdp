// What the UI says about a failed API call: the message of its code, `errors.<code>`; a code
// without a message (a newer server's) or a failure that is not an ApiError reads `errors.unknown`
// with that code. An upload failure's `details.reason` reads `upload.reasons.<reason>`, a reason
// without a message as it is. vue-i18n's te() tells whether a message exists;
// tests/web/locales.test.ts checks that every code and reason the server sends has one.
import { ApiError } from "@/client/errors";
import type { I18nText } from "@/i18n";

/** The message of `error` in the UI language, by its code: ApiError's code, else the error's name. */
export function errorMessage(error: unknown, { t, te }: Pick<I18nText, "t" | "te">): string {
  const code =
    error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
  const key = `errors.${code}`;
  return t(te(key) ? key : "errors.unknown", { code });
}

/** The `details.reason` of a failure in the UI language; null without one. */
export function errorReason(error: unknown, { t, te }: Pick<I18nText, "t" | "te">): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== "string") {
    return null;
  }
  const key = `upload.reasons.${reason}`;
  return te(key) ? t(key) : reason;
}
