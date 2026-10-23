// Request media types, shared by the upload routes (admin certificate import, CRL upload).
import { createMiddleware } from "hono/factory";
import { ApiError } from "./errors.ts";

/** The essence of a Content-Type (`type/subtype`, lowercase), or undefined without one. */
function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "" ? undefined : type;
}

/**
 * Route middleware: 415 unsupported_media_type, with the received and the accepted media types,
 * unless the Content-Type is one of `accepted` (parameters and case ignored). A missing or empty
 * Content-Type is none of them. The body is not read: the format is recognized from the bytes.
 */
export function mediaTypeGate(accepted: readonly string[], message: string) {
  return createMiddleware(async (c, next) => {
    const type = mediaType(c.req.header("Content-Type"));
    if (type === undefined || !accepted.includes(type)) {
      throw new ApiError(415, "unsupported_media_type", message, {
        received: type ?? null,
        accepted,
      });
    }
    await next();
  });
}
