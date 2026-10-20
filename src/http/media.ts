// Request media types, shared by the upload routes (admin certificate import, CRL upload).

export const MULTIPART = "multipart/form-data";

/** The essence of a Content-Type (`type/subtype`, lowercase), or undefined without one. */
export function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}
