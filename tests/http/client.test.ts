// The typed client the web app uses (hc<AppType>, src/web/client/api.ts), run against the app
// in-process. The type assertions are checked by `pnpm run typecheck:node` (tsconfig.node.json
// includes tests/): expectTypeOf is a no-op at run time.
import { hc } from "hono/client";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import type { AppType } from "../../src/http/app.ts";
import { MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";

function client(overrides: TestOverrides = {}) {
  const app = createApp(testDeps(overrides));
  return hc<AppType>("http://test.local", { fetch: app.request });
}

describe("hc<AppType>", () => {
  it("narrows a 200 body to healthy | degraded", async () => {
    const res = await client().api.v1.health.$get();
    expect(res.status).toBe(200);
    if (res.status !== 200) {
      throw new Error(`unexpected status ${res.status}`);
    }
    const body = await res.json();
    expectTypeOf(body.status).toEqualTypeOf<"healthy" | "degraded">();
    expectTypeOf(body.checks.configuration).toEqualTypeOf<"ok" | "missing" | "invalid">();
    // @ts-expect-error -- the body is typed from the route's 200 schema, not any
    expectTypeOf(body).toBeAny();
    expect(body).toEqual({ status: "degraded", checks: { store: "ok", configuration: "missing" } });
  });

  it("reports healthy with the minimal configuration", async () => {
    const store = patchStore({});
    await putText(store, "config.json", MINIMAL_CONFIG);
    const res = await client({ store }).api.v1.health.$get();
    if (res.status !== 200) {
      throw new Error(`unexpected status ${res.status}`);
    }
    expect((await res.json()).status).toBe("healthy");
  });

  it("narrows a 503 body to unhealthy", async () => {
    const store = patchStore({ head: () => Promise.reject(new Error("store down")) });
    const res = await client({ store }).api.v1.health.$get();
    expect(res.status).toBe(503);
    if (res.status !== 503) {
      throw new Error(`unexpected status ${res.status}`);
    }
    const body = await res.json();
    expectTypeOf(body.status).toEqualTypeOf<"unhealthy">();
    expectTypeOf(body.checks).toEqualTypeOf<{ store: "error"; configuration: "unknown" }>();
    // @ts-expect-error -- the body is typed from the route's 503 schema, not any
    expectTypeOf(body).toBeAny();
    expect(body).toEqual({
      status: "unhealthy",
      checks: { store: "error", configuration: "unknown" },
    });
  });
});
