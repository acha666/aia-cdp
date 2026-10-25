// Server state of the UI: `queries`, one TanStack Query options factory (key and request) per API
// read, and the CRL upload as a mutation. A component calls useQuery(queries.stats()); a detail
// page passes a getter, useQuery(() => queries.certificate(props.id)), so its query follows the
// route. The query cache dedupes requests, drops the answers of superseded ones and keeps the
// previous data while a key refetches. Every read is `unwrap(await api…$get(…))`, so a failure is
// an ApiError (errors.ts) or an abort. ["health"] is HealthBadge's own query: its 503 body is not
// an envelope, so it reads the status code itself.
import { QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/vue-query";
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

export const queries = {
  stats: () =>
    queryOptions({
      queryKey: ["stats"],
      queryFn: async ({ signal }) => unwrap(await v1.stats.$get(undefined, { init: { signal } })),
    }),
  certificates: () =>
    queryOptions({
      queryKey: ["certificates"],
      queryFn: async ({ signal }) =>
        unwrap(await v1.certificates.$get(undefined, { init: { signal } })),
    }),
  /**
   * One certificate. `id` must be one the router's pattern matched or the server sent: hono/client
   * puts path parameters into the URL as they are.
   */
  certificate: (id: string) =>
    queryOptions({
      queryKey: ["certificate", id],
      queryFn: async ({ signal }) =>
        unwrap(await v1.certificates[":id"].$get({ param: { id } }, { init: { signal } })),
    }),
  crls: () =>
    queryOptions({
      queryKey: ["crls"],
      queryFn: async ({ signal }) => unwrap(await v1.crls.$get(undefined, { init: { signal } })),
    }),
  /** One CRL target; the same rule for `targetId` as for `certificate`'s `id`. */
  crl: (targetId: string) =>
    queryOptions({
      queryKey: ["crl", targetId],
      queryFn: async ({ signal }) =>
        unwrap(await v1.crls[":targetId"].$get({ param: { targetId } }, { init: { signal } })),
    }),
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
 * request's headers only. A success refreshes every query: the data is small, and lists, details
 * and stats all change.
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
