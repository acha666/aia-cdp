// The query layer (implementation slice 5b step 5) against a stubbed fetch. The first case is
// worker-aia-cdp@5b570aa:tests/web/collection-loader.test.ts case 3 rewritten for TanStack Query:
// a list request sent before an upload must not overwrite the refresh that follows it.
import { focusManager, VueQueryPlugin } from "@tanstack/vue-query";
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import {
  deferred,
  envelope,
  publishedCrl,
  rootDetail,
  stubApi,
  TARGET_IDS,
  targetItems,
  testQueryClient,
} from "./helpers";
import { ApiError } from "@/client/errors";
import {
  createQueryClient,
  shouldRetry,
  useCertificate,
  useCertificates,
  useCrlTarget,
  useCrlTargets,
  useStats,
  useUploadCrl,
} from "@/client/queries";
import type { CrlTargetList } from "@/client/types";

let wrapper: VueWrapper | undefined;
let client: QueryClient | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  client?.clear();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

/** Mounts `use` in a component with the app's QueryClient (retries without delay). */
function harness<T>(use: () => T): T {
  client = testQueryClient();
  let result!: T;
  wrapper = mount(
    defineComponent({
      setup() {
        result = use();
        return () => h("div");
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } }
  );
  return result;
}

const OLD_LIST = targetItems().map((target) => ({ ...target, current: null }));
const NEW_LIST = targetItems();
const FILE = new File(["-----BEGIN X509 CRL-----"], "crl.pem");

describe("useUploadCrl", () => {
  it.each([
    ["the first load", false],
    ["a refetch", true],
  ])("refreshes after the upload even while %s sent before it is in flight", async (_, loaded) => {
    const stale = deferred<Response>();
    const lists: (RequestInit | undefined)[] = [];
    const api = stubApi({
      "GET /api/v1/crls": (init) => {
        lists.push(init);
        if (lists.length === (loaded ? 2 : 1)) {
          return stale.promise;
        }
        return Response.json(lists.length === 1 ? OLD_LIST : NEW_LIST);
      },
      "POST /api/v1/crls": () => Response.json(publishedCrl("created"), { status: 201 }),
    });
    const { targets, upload } = harness(() => ({
      targets: useCrlTargets(),
      upload: useUploadCrl(),
    }));
    await flushPromises();
    if (loaded) {
      expect(targets.data.value).toEqual(OLD_LIST);
      void targets.refetch();
      await flushPromises();
    }
    expect(targets.isFetching.value).toBe(true);

    await upload.mutateAsync({ file: FILE, token: "" });
    await flushPromises();
    expect(targets.data.value).toEqual(NEW_LIST);
    // The superseded request was aborted (the query function passes TanStack's signal on).
    expect(lists.at(-2)?.signal?.aborted).toBe(true);

    stale.resolve(Response.json(OLD_LIST satisfies CrlTargetList));
    await flushPromises();
    expect(targets.data.value).toEqual(NEW_LIST);
    expect(targets.isFetching.value).toBe(false);
    expect(api.calls()).toEqual([
      ...(loaded ? ["GET /api/v1/crls"] : []),
      "GET /api/v1/crls",
      "POST /api/v1/crls",
      "GET /api/v1/crls",
    ]);
  });

  it("sends the file as multipart crl, the token as a bearer header only when given", async () => {
    const api = stubApi({
      "POST /api/v1/crls": () => Response.json(publishedCrl("unchanged")),
    });
    const upload = harness(() => useUploadCrl());

    await upload.mutateAsync({ file: FILE, token: "" });
    await upload.mutateAsync({ file: FILE, token: "s3cret" });

    const posts = api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    const [withoutToken, withToken] = posts.map(([, init]) => init!);
    expect(withoutToken!.body).toBeInstanceOf(FormData);
    expect((withoutToken!.body as FormData).get("crl")).toBe(FILE);
    expect(new Headers(withoutToken!.headers).has("Authorization")).toBe(false);
    expect(new Headers(withToken!.headers).get("Authorization")).toBe("Bearer s3cret");
  });
});

describe("queries", () => {
  it("count every answer as stale at once and ask again when the window regains focus", async () => {
    const queries = createQueryClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(0);
    // TanStack's default (true) stays: no override.
    expect(queries).not.toHaveProperty("refetchOnWindowFocus");

    const api = stubApi({ "GET /api/v1/crls": () => Response.json(NEW_LIST) });
    const targets = harness(() => useCrlTargets());
    await flushPromises();
    expect(targets.data.value).toEqual(NEW_LIST);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flushPromises();
    expect(api.calls()).toEqual(["GET /api/v1/crls", "GET /api/v1/crls"]);
  });

  const DETAIL_ID = rootDetail().id;
  it.each([
    ["useStats", "GET /api/v1/stats", () => useStats()],
    ["useCertificates", "GET /api/v1/certificates", () => useCertificates()],
    ["useCertificate", `GET /api/v1/certificates/${DETAIL_ID}`, () => useCertificate(DETAIL_ID)],
    ["useCrlTargets", "GET /api/v1/crls", () => useCrlTargets()],
    [
      "useCrlTarget",
      `GET /api/v1/crls/${TARGET_IDS.issuingFull}`,
      () => useCrlTarget(TARGET_IDS.issuingFull),
    ],
  ])("%s hands TanStack's abort signal to its request", async (_, route, use) => {
    const requests: (RequestInit | undefined)[] = [];
    stubApi({
      [route]: (init) => {
        requests.push(init);
        return deferred<Response>().promise;
      },
    });
    harness<unknown>(use);
    await flushPromises();

    expect(requests).toHaveLength(1);
    const signal = requests[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await client!.cancelQueries();
    expect(signal?.aborted).toBe(true);
  });

  it("send every request with cache: no-store", async () => {
    const api = stubApi({ "GET /api/v1/crls": () => Response.json(NEW_LIST) });
    const targets = harness(() => useCrlTargets());
    await flushPromises();

    expect(targets.data.value).toEqual(NEW_LIST);
    expect(api.fetchMock).toHaveBeenCalled();
    for (const [, init] of api.fetchMock.mock.calls) {
      expect(init?.cache).toBe("no-store");
    }
  });

  it.each([
    ["a 404", 1, 404, () => envelope(404, "not_found")],
    ["a 400", 1, 400, () => envelope(400, "bad_request")],
    ["a 500", 2, 500, () => envelope(500, "internal")],
    ["a network failure", 2, 0, () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("gives up after %s with %i request(s)", async (_, requests, status, answer) => {
    const detail = rootDetail();
    const api = stubApi({ [`GET /api/v1/certificates/${detail.id}`]: answer });
    const certificate = harness(() => useCertificate(detail.id));

    // The retry waits for a timer (retryDelay 0 here), not only for promises.
    await vi.waitFor(() => {
      expect(certificate.isError.value).toBe(true);
    });
    expect(certificate.error.value).toBeInstanceOf(ApiError);
    expect((certificate.error.value as ApiError).status).toBe(status);
    expect(api.calls()).toHaveLength(requests);
  });

  it("retries once: TanStack counts the failures before this one", () => {
    const serverError = new ApiError(503, "internal", "x");
    expect(shouldRetry(0, serverError)).toBe(true);
    expect(shouldRetry(1, serverError)).toBe(false);
    expect(shouldRetry(0, new ApiError(0, "network", "x"))).toBe(true);
    expect(shouldRetry(0, new ApiError(409, "stale_crl", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(499, "x", "x"))).toBe(false);
  });
});
