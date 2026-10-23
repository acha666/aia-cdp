import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import HealthBadge from "@/components/HealthBadge.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

let wrapper: VueWrapper | undefined;
let queryClient: QueryClient | undefined;

afterEach(() => {
  wrapper?.unmount();
  queryClient?.clear();
  vi.unstubAllGlobals();
});

function stubFetch(result: () => Promise<Response>) {
  const fetchMock =
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(result);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mountBadge(locale: AppLocale) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wrapper = mount(HealthBadge, {
    global: { plugins: [createAppI18n(locale), [VueQueryPlugin, { queryClient }]] },
  });
  return wrapper;
}

describe("HealthBadge", () => {
  it("calls GET /api/v1/health and shows degraded in zh-CN", async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ status: "degraded", checks: { store: "ok", configuration: "missing" } })
    );
    const badge = mountBadge("zh-CN");

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("loading");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("检查中…");

    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input] = fetchMock.mock.calls[0]!;
    expect(input instanceof Request ? input.url : input.toString()).toMatch(/\/api\/v1\/health$/);
    const root = badge.get('[data-slot="badge"]');
    expect(root.attributes("role")).toBe("status");
    expect(root.attributes("data-state")).toBe("degraded");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("降级");
    expect(root.text()).toContain("服务状态：");
    expect(root.attributes("title")).toBe("存储正常，但尚未应用配置。");
  });

  it.each([
    [
      "healthy for a 200 healthy response",
      () => Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } }),
      "healthy",
      "Healthy",
    ],
    [
      "unhealthy for a 503 response",
      () =>
        Response.json(
          { status: "unhealthy", checks: { store: "error", configuration: "unknown" } },
          { status: 503 }
        ),
      "unhealthy",
      "Unhealthy",
    ],
    [
      "unknown when the request fails",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "unknown",
      "Unknown",
    ],
    [
      "unknown for a status the API never sends",
      () => new Response("Bad Gateway", { status: 502 }),
      "unknown",
      "Unknown",
    ],
  ])("shows %s", async (_, answer, state, label) => {
    stubFetch(async () => answer());
    const badge = mountBadge("en");
    await flushPromises();

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe(state);
    expect(badge.get('[data-testid="health-state"]').text()).toBe(label);
  });
});
