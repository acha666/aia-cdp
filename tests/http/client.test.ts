// The typed client the web app uses (hc<AppType>, src/web/client/api.ts), run against the app
// in-process, with the web's unwrap (src/web/client/errors.ts) on the app's real bodies. The type
// assertions are checked by `pnpm run typecheck:node` (tsconfig.node.json includes tests/):
// expectTypeOf is a no-op at run time.
import { hc } from "hono/client";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import type { AppType } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { ApiError, unwrap } from "../../src/web/client/errors.ts";
import { fixture, manifest } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { setupPublish } from "../helpers/publish.ts";

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
    const store = patchStore({ get: () => Promise.reject(new Error("store down")) });
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
  // The upload card of slice 5b posts through this client.
  it("posts a CRL as the multipart field crl and narrows the 201 and 422 bodies", async () => {
    const store = new MemoryStore();
    const setup = await setupPublish(store);
    const crls = client({ store }).api.v1.crls;
    const file = "crls/root-ca/full-01.der";
    const der = new File([fixture(file)], "root-ca.crl");
    const res = await crls.$post({ form: { crl: der } });
    expect(res.status).toBe(201);
    if (res.status !== 201) {
      throw new Error(`unexpected status ${res.status}`);
    }
    const body = await res.json();
    expectTypeOf(body.outcome).toEqualTypeOf<"created" | "updated" | "unchanged">();
    expectTypeOf(body.nextUpdate).toEqualTypeOf<string | null>();
    // @ts-expect-error -- the body is typed from the route's 201 schema, not any
    expectTypeOf(body).toBeAny();
    expect(body).toMatchObject({
      outcome: "created",
      target: setup.target("root-ca", "full"),
      sha256: manifest.crls.find((crl) => crl.file === file)?.sha256,
    });

    const rejected = await crls.$post({ form: { crl: "not a CRL" } });
    expect(rejected.status).toBe(422);
    if (rejected.status !== 422) {
      throw new Error(`unexpected status ${rejected.status}`);
    }
    const error = (await rejected.json()).error;
    expectTypeOf(error.code).toEqualTypeOf<
      | "invalid_crl"
      | "not_yet_valid"
      | "unknown_critical_extension"
      | "scoped_crl_unsupported"
      | "issuer_not_found"
      | "target_not_configured"
      | "invalid_signature"
      | "unsupported_algorithm"
    >();
    expect(error).toMatchObject({ code: "invalid_crl", details: { reason: "der" } });
  });

  it("unwraps the app's 200 body and its error envelopes", async () => {
    const store = new MemoryStore();
    const setup = await setupPublish(store);
    const v1 = client({ store }).api.v1;

    const targets = await unwrap(await v1.crls.$get());
    expectTypeOf(targets[0]!.issuer.subjectCN).toEqualTypeOf<string | null>();
    expect(targets.map((target) => target.targetId)).toContain(setup.target("root-ca", "full"));

    // A certificate of the manifest that is never imported (leaf certificates).
    const unknown = manifest.certificates.find((certificate) => !certificate.import);
    const notFound = unwrap(await v1.certificates[":id"].$get({ param: { id: unknown!.sha256 } }));
    await expect(notFound).rejects.toThrow(ApiError);
    await expect(notFound).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      unwrap(await v1.crls[":targetId"].$get({ param: { targetId: "not-a-uuid" } }))
    ).rejects.toMatchObject({ code: "bad_request", status: 400 });
  });
});
