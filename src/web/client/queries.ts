// Server state of the UI (implementation slice 5b step 5): one TanStack Query key per API read and
// the CRL upload as a mutation. Replaces worker-aia-cdp@5b570aa's stores/*, useCollectionLoader and
// useDetailCache: the query cache dedupes requests, drops the answers of superseded ones and keeps
// the previous data while a key refetches. Every read is `unwrap(await api…$get(…))`, so a failure
// is an ApiError (errors.ts) or an abort. ["health"] is HealthBadge's own query: its 503 body is not
// an envelope, so it reads the status code itself.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";
import { api } from "./api";
import { ApiError, unwrap } from "./errors";
import type { CrlTargetList } from "./types";

const v1 = api.api.v1;

export const queryKeys = {
  health: ["health"],
  stats: ["stats"],
  certificates: ["certificates"],
  certificate: (id: MaybeRefOrGetter<string>) => ["certificate", id] as const,
  crls: ["crls"],
  crl: (targetId: MaybeRefOrGetter<string>) => ["crl", targetId] as const,
} as const;

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
    // server again; API responses are `no-store` anyway (plan §10 #17).
    defaultOptions: { queries: { staleTime: 0, retry: shouldRetry } },
  });
}

export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: async ({ signal }) => unwrap(await v1.stats.$get(undefined, { init: { signal } })),
  });
}

export function useCertificates() {
  return useQuery({
    queryKey: queryKeys.certificates,
    queryFn: async ({ signal }) =>
      unwrap(await v1.certificates.$get(undefined, { init: { signal } })),
  });
}

/**
 * One certificate. `id` must be one the router's pattern matched or the server sent: hono/client
 * puts path parameters into the URL as they are (slice 5a review).
 */
export function useCertificate(id: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: queryKeys.certificate(id),
    queryFn: async ({ signal }) =>
      unwrap(
        await v1.certificates[":id"].$get({ param: { id: toValue(id) } }, { init: { signal } })
      ),
  });
}

export function useCrlTargets() {
  return useQuery({
    queryKey: queryKeys.crls,
    queryFn: async ({ signal }) => unwrap(await v1.crls.$get(undefined, { init: { signal } })),
  });
}

/** One CRL target; the same rule for `targetId` as for useCertificate's `id`. */
export function useCrlTarget(targetId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: queryKeys.crl(targetId),
    queryFn: async ({ signal }) =>
      unwrap(
        await v1.crls[":targetId"].$get(
          { param: { targetId: toValue(targetId) } },
          { init: { signal } }
        )
      ),
  });
}

export interface UploadCrlInput {
  /** DER or PEM bytes; pasted text is wrapped as a File by the caller (M8: never a string field). */
  file: File;
  /** AIA_UPLOAD_TOKEN; empty: no Authorization header (bearerAuth answers 400 to an empty one). */
  token: string;
}

/** The target's label from the cached ["crls"] list, when that list has it. */
export function cachedTargetLabel(client: QueryClient, targetId: string): string | undefined {
  return client
    .getQueryData<CrlTargetList>(queryKeys.crls)
    ?.find((target) => target.targetId === targetId)?.label;
}

/**
 * POST /api/v1/crls as multipart `crl`; the token, when given, goes in this request's headers only
 * (the client's shared `init` carries nothing but `cache`). A success refreshes every query: the
 * data is small, and lists, details and stats all change.
 */
export function useUploadCrl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, token }: UploadCrlInput) =>
      unwrap(
        await v1.crls.$post(
          { form: { crl: file } },
          token === "" ? undefined : { headers: { Authorization: `Bearer ${token}` } }
        )
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
