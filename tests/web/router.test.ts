// Routes of the web app (implementation slice 1, updated in slice 5b step 6): the pages each path
// renders, the props of the lazy detail pages, that a malformed id never becomes a request, and
// where a navigation leaves the scroll position.
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import type { RouteLocationNormalized } from "vue-router";
import { mountApp, stubApi } from "./helpers";
import CertificatePage from "@/pages/CertificatePage.vue";
import CrlTargetPage from "@/pages/CrlTargetPage.vue";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";
import { createAppRouter } from "@/router";
import { siteName } from "@/site";

const TARGET_ID = "0b7c5f2e-6d1a-4c3b-9e8f-1a2b3c4d5e6f";
const CERTIFICATE_ID = "3f1c".repeat(16);

let wrapper: VueWrapper | undefined;
let queryClient: QueryClient | undefined;
let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  // Health answers healthy; every other API path is a 404 envelope.
  api = stubApi({});
});

afterEach(() => {
  wrapper?.unmount();
  queryClient?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountAt(path: string) {
  const mounted = await mountApp(path);
  ({ wrapper, queryClient } = mounted);
  return mounted;
}

describe("createAppRouter", () => {
  it("renders the overview at /", async () => {
    const { router, wrapper } = await mountAt("/");

    expect(router.currentRoute.value.name).toBe("overview");
    expect(wrapper.findComponent(OverviewPage).exists()).toBe(true);
  });

  it("lazy-loads CrlTargetPage for /crls/:targetId and passes the param as a prop", async () => {
    const { router, wrapper } = await mountAt(`/crls/${TARGET_ID}`);

    expect(router.currentRoute.value.name).toBe("crl");
    expect(router.currentRoute.value.params.targetId).toBe(TARGET_ID);
    const page = wrapper.findComponent(CrlTargetPage);
    expect(page.exists()).toBe(true);
    expect(page.props("targetId")).toBe(TARGET_ID);
    expect(api.calls()).toEqual([`GET /api/v1/crls/${TARGET_ID}`]);
  });

  it("lazy-loads CertificatePage for /certificates/:id", async () => {
    const { router, wrapper } = await mountAt(`/certificates/${CERTIFICATE_ID}`);

    expect(router.currentRoute.value.name).toBe("certificate");
    const page = wrapper.findComponent(CertificatePage);
    expect(page.exists()).toBe(true);
    expect(page.props("id")).toBe(CERTIFICATE_ID);
    expect(api.calls()).toEqual([`GET /api/v1/certificates/${CERTIFICATE_ID}`]);
  });

  it.each([
    ["an uppercase certificate id", `/certificates/${CERTIFICATE_ID.toUpperCase()}`],
    ["a short certificate id", `/certificates/${CERTIFICATE_ID.slice(1)}`],
    ["a path in the id", "/certificates/..%2Fstats"],
    ["a target id that is no UUID", "/crls/not-a-uuid"],
    ["a target id of hex digits and dashes that is no UUID", "/crls/0123-abcd"],
    ["a target id one digit short", `/crls/${TARGET_ID.slice(0, -1)}`],
    ["an uppercase target id", `/crls/${TARGET_ID.toUpperCase()}`],
    ["a nested target path", `/crls/${TARGET_ID}/extra`],
  ])("renders NotFoundPage for %s without a request", async (_, path) => {
    const { router, wrapper } = await mountAt(path);

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
    expect(api.calls()).toEqual([]);
  });

  it("renders NotFoundPage for an unknown path", async () => {
    const { router, wrapper } = await mountAt("/nope");

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
    expect(wrapper.findComponent(OverviewPage).exists()).toBe(false);
    expect(wrapper.text()).toContain("/nope");
    expect(document.title).toBe("Page not found · Test PKI");
  });

  it("shows the build-time site name in the header", async () => {
    const { wrapper } = await mountAt("/");

    expect(siteName).toBe("Test PKI");
    expect(wrapper.get('[data-testid="site-name"]').text()).toBe("Test PKI");
    expect(document.title).toBe("Overview · Test PKI");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("scroll behaviour", () => {
  const { scrollBehavior } = createAppRouter(createMemoryHistory()).options;
  const at = (fullPath: string) => {
    const url = new URL(fullPath, "http://test");
    return { fullPath, path: url.pathname, hash: url.hash } as RouteLocationNormalized;
  };
  const overview = at("/");
  const certificate = at(`/certificates/${CERTIFICATE_ID}`);

  it("opens another page at its top", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const { router } = await mountAt("/");
    scrollTo.mockClear();

    await router.push(`/certificates/${CERTIFICATE_ID}`);
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("restores the position of a back / forward step and goes to a fragment", () => {
    expect(scrollBehavior).toBeDefined();
    const saved = { left: 0, top: 640 };
    expect(scrollBehavior!(overview, certificate, saved)).toEqual(saved);
    expect(scrollBehavior!(certificate, overview, null)).toEqual({ top: 0 });
    // The skip link (#main), and a query or fragment on the same page: no jump to the top.
    expect(scrollBehavior!(at("/#main"), overview, null)).toEqual({ el: "#main" });
    expect(scrollBehavior!(at("/?x=1"), overview, null)).toBe(false);
  });
});
