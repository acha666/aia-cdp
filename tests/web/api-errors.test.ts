// The web client's error handling (implementation slice 5a step 10): unwrap and the hc client's
// fetch. Rewrite of worker-aia-cdp@5b570aa:tests/web/state.test.ts case (3): malformed responses
// and HTTP errors fail with a code instead of turning into an empty success. The fetch is stubbed;
// the bodies are the v1 envelope as src/http/errors.ts writes it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/client/api";
import { ApiError, unwrap } from "@/client/errors";

const STATS = {
  certificates: 2,
  targets: { full: 1, delta: 1 },
  published: { full: 1, delta: 0 },
  totalRevocations: 3,
  derBytes: 4096,
};

const TARGET_ID = "0b7c5f2e-6d1a-4c3b-9e8f-1a2b3c4d5e6f";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(result: (init?: RequestInit) => Promise<Response>) {
  // hc passes the URL as a string.
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    (_input, init) => result(init)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The rejection of a promise, which must reject. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (error: unknown) => error
  );
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("unwrap", () => {
  it("returns the body of a 2xx response", async () => {
    stubFetch(async () => Response.json(STATS));
    expect(await unwrap(await api.api.v1.stats.$get())).toEqual(STATS);
  });

  it("throws the envelope's code, message and details with the HTTP status", async () => {
    const notFound = await apiError(
      unwrap(
        Response.json(
          { error: { code: "not_found", message: "No CRL target with this id is configured" } },
          { status: 404 }
        )
      )
    );
    expect(notFound).toMatchObject({
      name: "ApiError",
      code: "not_found",
      status: 404,
      message: "No CRL target with this id is configured",
      details: undefined,
    });

    const rejected = await apiError(
      unwrap(
        Response.json(
          { error: { code: "invalid_crl", message: "Not a CRL", details: { reason: "der" } } },
          { status: 422 }
        )
      )
    );
    expect(rejected).toMatchObject({
      code: "invalid_crl",
      status: 422,
      details: { reason: "der" },
    });
  });

  it("keeps a code this client does not know", async () => {
    const error = await apiError(
      unwrap(Response.json({ error: { code: "brand_new", message: "Newer" } }, { status: 409 }))
    );
    expect(error).toMatchObject({ code: "brand_new", status: 409 });
  });

  it.each([
    ["an HTML page", new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["an empty body", new Response(null, { status: 500 })],
    ["JSON that is not the envelope", Response.json({ status: "unhealthy" }, { status: 503 })],
    ["an envelope without a message", Response.json({ error: { code: "x" } }, { status: 400 })],
    ["HTML with 200", new Response("<!doctype html><title>UI</title>", { status: 200 })],
  ])("throws invalid_response for %s", async (_name, response) => {
    const error = await apiError(unwrap(response));
    expect(error).toMatchObject({ code: "invalid_response", status: response.status });
  });
});

describe("api (hc<AppType>)", () => {
  it("sends every request with init.cache = no-store", async () => {
    const fetchMock = stubFetch(async () => Response.json(STATS));
    await api.api.v1.stats.$get();
    await api.api.v1.crls[":targetId"].$get(
      { param: { targetId: TARGET_ID } },
      { init: { signal: new AbortController().signal } }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [statsUrl, statsInit] = fetchMock.mock.calls[0]!;
    expect(statsUrl).toBe("/api/v1/stats");
    expect(statsInit?.cache).toBe("no-store");
    expect(statsInit?.method).toBe("GET");
    // A per-request init (TanStack Query's signal) is merged with the client's, not instead of it.
    const [targetUrl, targetInit] = fetchMock.mock.calls[1]!;
    expect(targetUrl).toBe(`/api/v1/crls/${TARGET_ID}`);
    expect(targetInit?.cache).toBe("no-store");
    expect(targetInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with ApiError network when fetch fails", async () => {
    const failure = new TypeError("Failed to fetch");
    stubFetch(async () => {
      throw failure;
    });
    const error = await apiError(api.api.v1.certificates.$get());
    expect(error).toMatchObject({ code: "network", status: 0 });
    expect(error.cause).toBe(failure);
  });

  it("keeps an abort as it is", async () => {
    stubFetch(async (init) => {
      throw init?.signal?.reason;
    });
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      api.api.v1.certificates.$get({}, { init: { signal: controller.signal } })
    );
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
