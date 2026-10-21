import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import App from "@/App.vue";
import { createAppI18n } from "@/i18n";
import CertificatePage from "@/pages/CertificatePage.vue";
import CrlPage from "@/pages/CrlPage.vue";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";
import { createAppRouter } from "@/router";
import { siteName } from "@/site";

const TARGET_ID = "0b7c5f2e-6d1a-4c3b-9e8f-1a2b3c4d5e6f";
const CERTIFICATE_ID = "3f1c".repeat(16);

let wrapper: VueWrapper | undefined;
let queryClient: QueryClient | undefined;

beforeEach(() => {
  // The header's HealthBadge fetches on mount.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } })
    )
  );
});

afterEach(() => {
  wrapper?.unmount();
  queryClient?.clear();
  vi.unstubAllGlobals();
});

async function mountAt(path: string) {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wrapper = mount(App, {
    global: { plugins: [router, createAppI18n("en"), [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return { router, wrapper };
}

describe("createAppRouter", () => {
  it("renders the overview at /", async () => {
    const { router, wrapper } = await mountAt("/");

    expect(router.currentRoute.value.name).toBe("overview");
    expect(wrapper.findComponent(OverviewPage).exists()).toBe(true);
  });

  it("lazy-loads CrlPage for /crls/:targetId and passes the param as a prop", async () => {
    const { router, wrapper } = await mountAt(`/crls/${TARGET_ID}`);

    expect(router.currentRoute.value.name).toBe("crl");
    expect(router.currentRoute.value.params.targetId).toBe(TARGET_ID);
    const page = wrapper.findComponent(CrlPage);
    expect(page.exists()).toBe(true);
    expect(page.props("targetId")).toBe(TARGET_ID);
    expect(page.get('[data-testid="route-param"]').text()).toBe(TARGET_ID);
  });

  it("lazy-loads CertificatePage for /certificates/:id", async () => {
    const { router, wrapper } = await mountAt(`/certificates/${CERTIFICATE_ID}`);

    expect(router.currentRoute.value.name).toBe("certificate");
    const page = wrapper.findComponent(CertificatePage);
    expect(page.exists()).toBe(true);
    expect(page.props("id")).toBe(CERTIFICATE_ID);
  });

  it.each([
    ["an uppercase certificate id", `/certificates/${CERTIFICATE_ID.toUpperCase()}`],
    ["a short certificate id", `/certificates/${CERTIFICATE_ID.slice(1)}`],
    ["a path in the id", "/certificates/..%2Fstats"],
    ["a target id that is no UUID", "/crls/not-a-uuid"],
    ["an uppercase target id", `/crls/${TARGET_ID.toUpperCase()}`],
    ["a nested target path", `/crls/${TARGET_ID}/extra`],
  ])("renders NotFoundPage for %s", async (_, path) => {
    const { router, wrapper } = await mountAt(path);

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
  });

  it("renders NotFoundPage for an unknown path", async () => {
    const { router, wrapper } = await mountAt("/nope");

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
    expect(wrapper.findComponent(OverviewPage).exists()).toBe(false);
    expect(wrapper.text()).toContain("/nope");
  });

  it("shows the build-time site name in the header", async () => {
    const { wrapper } = await mountAt("/");

    expect(siteName).toBe("Test PKI");
    expect(wrapper.get("header a").text()).toBe("Test PKI");
    expect(document.documentElement.lang).toBe("en");
  });
});
