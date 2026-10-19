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

function mountBadge(
  locale: AppLocale,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  queryClient = client;
  wrapper = mount(HealthBadge, {
    global: { plugins: [createAppI18n(locale), [VueQueryPlugin, { queryClient }]] },
  });
  return wrapper;
}

const DEGRADED = { status: "degraded", checks: { store: "ok", configuration: "missing" } };
const UNHEALTHY = { status: "unhealthy", checks: { store: "error", configuration: "unknown" } };

describe("HealthBadge", () => {
  it("calls GET /api/v1/health with cache: no-store and shows degraded in zh-CN", async () => {
    const fetchMock = stubFetch(async () => Response.json(DEGRADED));
    const badge = mountBadge("zh-CN");

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("loading");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("检查中…");

    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = input instanceof Request ? input.url : input.toString();
    expect(url).toMatch(/\/api\/v1\/health$/);
    expect(init?.cache).toBe("no-store");
    expect(init?.method).toBe("GET");

    const root = badge.get('[data-slot="badge"]');
    expect(root.attributes("role")).toBe("status");
    expect(root.attributes("data-state")).toBe("degraded");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("降级");
    expect(root.text()).toContain("服务状态：");
    expect(root.attributes("title")).toBe("存储正常，但尚未应用配置。");
  });

  it("shows healthy for a 200 healthy response", async () => {
    stubFetch(async () =>
      Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } })
    );
    const badge = mountBadge("en");
    await flushPromises();

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("healthy");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("Healthy");
  });

  it("shows unhealthy for a 503 response", async () => {
    stubFetch(async () => Response.json(UNHEALTHY, { status: 503 }));
    const badge = mountBadge("en");
    await flushPromises();

    const root = badge.get('[data-slot="badge"]');
    expect(root.attributes("data-state")).toBe("unhealthy");
    expect(root.attributes("data-variant")).toBe("destructive");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("Unhealthy");
  });

  it("shows unknown when the request fails", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const badge = mountBadge("en");
    await flushPromises();

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("unknown");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("Unknown");
  });

  it("does not retry: unknown right after one failed request, even with library defaults", async () => {
    const fetchMock = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    // A client without retry: false (TanStack default: 3 retries, 1 + 2 + 4 s backoff).
    const badge = mountBadge("en", new QueryClient());
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("unknown");
  });

  it("shows unknown for a status the API never sends", async () => {
    stubFetch(async () => new Response("Bad Gateway", { status: 502 }));
    const badge = mountBadge("zh-CN");
    await flushPromises();

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("unknown");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("未知");
  });
});
