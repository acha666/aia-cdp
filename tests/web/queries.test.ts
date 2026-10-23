// The query layer against a stubbed fetch: the upload's request and the list refresh after it (a
// list request sent before an upload must not overwrite the refresh that follows it), and the
// retry rule.
import { VueQueryPlugin } from "@tanstack/vue-query";
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { deferred, publishedCrl, stubApi, targetItems, testQueryClient } from "./helpers";
import { ApiError } from "@/client/errors";
import { shouldRetry, useCrlTargets, useUploadCrl } from "@/client/queries";
import type { CrlTargetList } from "@/client/types";

let wrapper: VueWrapper | undefined;
let client: QueryClient | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  client?.clear();
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

  it("sends the file as the body, the token as a bearer header only when given", async () => {
    const api = stubApi({
      "POST /api/v1/crls": () => Response.json(publishedCrl("unchanged")),
    });
    const upload = harness(() => useUploadCrl());

    await upload.mutateAsync({ file: FILE, token: "" });
    await upload.mutateAsync({ file: FILE, token: "s3cret" });

    const posts = api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    const [withoutToken, withToken] = posts.map(([, init]) => init!);
    expect(withoutToken!.body).toBe(FILE);
    expect(new Headers(withoutToken!.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(new Headers(withoutToken!.headers).has("Authorization")).toBe(false);
    expect(new Headers(withToken!.headers).get("Authorization")).toBe("Bearer s3cret");
  });
});

describe("shouldRetry", () => {
  it("retries a 5xx or a failed request once, never a 4xx", () => {
    // TanStack passes the failures before this one: 0 at the first failure.
    const serverError = new ApiError(503, "internal", "x");
    expect(shouldRetry(0, serverError)).toBe(true);
    expect(shouldRetry(1, serverError)).toBe(false);
    expect(shouldRetry(0, new ApiError(0, "network", "x"))).toBe(true);
    expect(shouldRetry(0, new ApiError(409, "stale_crl", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(499, "x", "x"))).toBe(false);
  });
});
