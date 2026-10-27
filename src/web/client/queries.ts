// Server state of the UI: `queries`, one TanStack Query options factory (key and request) per API
// read, and the CRL upload as a mutation. A component calls useQuery(queries.crls()); a detail
// page passes a getter, useQuery(() => queries.certificateBlob(props.id)), so its query follows
// the route. The query cache dedupes requests, drops the answers of superseded ones and keeps the
// previous data while a key refetches. Every read is `unwrap(await api…$get(…))`, so a failure is
// an ApiError (errors.ts) or an abort. ["health"] is HealthBadge's own query: its 503 body is not
// an envelope, so it reads the status code itself.
import { QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/vue-query";
import { markRaw } from "vue";
import type { Certificate } from "pkijs";
import type * as Parsers from "../../core/pki/parsers.ts";
import type { WholeCrl } from "../../core/pki/parsers.ts";
import { api } from "./api";
import { ApiError, unwrap } from "./errors";

const v1 = api.api.v1;

/**
 * 4xx answers are final (a detail page's 404 shows at once instead of after the backoff); a
 * request without a response (`network`, status 0) or a 5xx gets one more try. TanStack passes the
 * failures before this one, so `failureCount` is 0 at the first failure.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const final = error instanceof ApiError && error.status >= 400 && error.status < 500;
  return !final && failureCount < 1;
}

/** The app's QueryClient (main.ts); tests build theirs here too. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    // staleTime 0: every mount and window focus (TanStack's default refetchOnWindowFocus) asks the
    // server again; API responses are `no-store` anyway.
    defaultOptions: { queries: { staleTime: 0, retry: shouldRetry } },
  });
}

/**
 * GET /api/v1/blobs/{sha256}, decoded by `parse` from core/pki/parsers.ts, which is loaded with the
 * first blob (asn1js and PKIjs are a chunk of their own). A blob never changes: it may come from
 * the browser's cache and is never stale. The decoded object is markRaw: Vue must not wrap PKIjs's
 * objects in proxies. A blob that does not decode fails with ApiError `code`, the server's 422 for
 * such content: final, since another try reads the same bytes.
 */
function blobQuery<T extends object>(
  sha256: string,
  code: "invalid_certificate" | "invalid_crl",
  parse: (parsers: typeof Parsers, der: Uint8Array) => T
) {
  return queryOptions({
    queryKey: ["blob", sha256],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const parsers = import("../../core/pki/parsers.ts");
      const res = await v1.blobs[":sha256"].$get(
        { param: { sha256 } },
        { init: { signal, cache: "default" } }
      );
      if (!res.ok) {
        await unwrap(res); // throws the envelope's ApiError
      }
      const der = new Uint8Array(await res.arrayBuffer());
      try {
        return markRaw(parse(await parsers, der));
      } catch (error) {
        throw new ApiError(422, code, `GET blob ${sha256}`, undefined, { cause: error });
      }
    },
  });
}

export const queries = {
  certificates: () =>
    queryOptions({
      queryKey: ["certificates"],
      queryFn: async ({ signal }) =>
        unwrap(await v1.certificates.$get(undefined, { init: { signal } })),
    }),
  crls: () =>
    queryOptions({
      queryKey: ["crls"],
      queryFn: async ({ signal }) => unwrap(await v1.crls.$get(undefined, { init: { signal } })),
    }),
  /**
   * A certificate by its id. `sha256` must be one the router's pattern matched or the server sent:
   * hono/client puts path parameters into the URL as they are.
   */
  certificateBlob: (sha256: string) =>
    blobQuery<Certificate>(sha256, "invalid_certificate", (parsers, der) =>
      parsers.parseCertificate(der)
    ),
  /** A target's current CRL by its `current.sha256`, every entry decoded. */
  crlBlob: (sha256: string) =>
    blobQuery<WholeCrl>(sha256, "invalid_crl", (parsers, der) => parsers.parseCRL(der)),
};

export interface UploadCrlInput {
  /** DER or PEM bytes; pasted text is wrapped as a File by the caller. */
  file: File;
  /** AIA_UPLOAD_TOKEN; empty: no Authorization header (bearerAuth answers 400 to an empty one). */
  token: string;
}

/**
 * POST /api/v1/crls with the file as the raw body (the server tells PEM from DER by the bytes):
 * the route's body is not JSON, so hc takes it as `init.body`. The token, when given, goes in this
 * request's headers only. A success refreshes every query: the data is small, and the lists
 * change (a blob never does).
 */
export function useUploadCrl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, token }: UploadCrlInput) =>
      unwrap(
        await v1.crls.$post(undefined, {
          headers: {
            "Content-Type": "application/octet-stream",
            ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
          },
          init: { body: file },
        })
      ),
    onSuccess: () => {
      // invalidateQueries does not restart a first load that is still in flight (TanStack only
      // cancels refetches of queries that have data), so a list request sent before the upload
      // would land afterwards and stay. Cancelling first discards every such answer; the refetch
      // then starts after the publication. Not awaited: the result shows without waiting for it.
      void client.cancelQueries().then(() => client.invalidateQueries());
    },
  });
}
