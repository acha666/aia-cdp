// Compile-time checks of the public route types (implementation slice 5a, test table): type-checked
// by `pnpm run typecheck:node` (tsconfig.node.json includes tests/), never run (not a *.test.ts).
// Each @ts-expect-error must stay live: if a route's response types widened (to the constraint
// type, or to any through hc<any>), the line would compile and the directive itself would fail.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { hc } from "hono/client";
import type { InferResponseType } from "hono/client";
import { expectTypeOf } from "vitest";
import type { CrlKind } from "../../src/core/catalog.ts";
import type { ExtensionType } from "../../src/core/summary/types.ts";
import type { AppType } from "../../src/http/app.ts";
import { getCertificateRoute } from "../../src/http/routes/certificates.ts";
import { getCrlTargetRoute } from "../../src/http/routes/crls.ts";
import { getStatsRoute } from "../../src/http/routes/stats.ts";
import type { AppEnv } from "../../src/http/types.ts";

const STATS = {
  certificates: 0,
  targets: { full: 0, delta: 0 },
  published: { full: 0, delta: 0 },
  totalRevocations: null,
  derBytes: 0,
};

// Handlers: the body must match the declared schema of the status, and the status must be declared.
export function handlers(app: OpenAPIHono<AppEnv>): void {
  app.openapi(getStatsRoute, (c) => c.json(STATS, 200));
  // @ts-expect-error -- totalRevocations is a number or null, not a string
  app.openapi(getStatsRoute, (c) => c.json({ ...STATS, totalRevocations: "none" }, 200));
  // @ts-expect-error -- derBytes is required
  app.openapi(getStatsRoute, (c) => c.json({ ...STATS, derBytes: undefined }, 200));
  // @ts-expect-error -- 201 is not a status of GET /api/v1/stats
  app.openapi(getStatsRoute, (c) => c.json(STATS, 201));
  // @ts-expect-error -- a CRL target detail is not a certificate detail
  app.openapi(getCertificateRoute, (c) => c.json({ ...STATS, id: "x" }, 200));
  // @ts-expect-error -- current is the detail's CrlCurrentDetail or null, never a string
  app.openapi(getCrlTargetRoute, (c) => c.json({ current: "none" }, 200));
}

const client = hc<AppType>("");

// hc narrows each body by status, and the extension values by extensionType.
export async function certificateDetail(): Promise<void> {
  const res = await client.api.v1.certificates[":id"].$get({ param: { id: "x" } });
  // @ts-expect-error -- 201 is not a declared status: a typed client knows the four it can get
  if (res.status === 201) {
    return;
  }
  if (res.status === 404) {
    const body = await res.json();
    expectTypeOf(body.error.code).toEqualTypeOf<"not_found">();
    return;
  }
  if (res.status !== 200) {
    const body = await res.json();
    expectTypeOf(body.error.code).toEqualTypeOf<"bad_request" | "internal">();
    return;
  }
  const body = await res.json();
  // @ts-expect-error -- the body is typed from the route's 200 schema, not any
  expectTypeOf(body).toBeAny();
  expectTypeOf(body.label).toEqualTypeOf<string | null>();
  expectTypeOf(body.summary.subjectCN).toEqualTypeOf<string | null>();
  expectTypeOf(body.targets[0]!.kind).toEqualTypeOf<CrlKind>();
  expectTypeOf(body.signatureAlgorithm.algorithm.oid).toBeString();
  const parsed = body.tbsCertificate.extensions?.items[0]?.parsed;
  expectTypeOf(parsed!.extensionType).toEqualTypeOf<ExtensionType>();
  if (parsed?.extensionType === "basicConstraints") {
    expectTypeOf(parsed.cA).toEqualTypeOf<boolean>();
    // @ts-expect-error -- keyCertSign belongs to the keyUsage variant
    expectTypeOf(parsed.keyCertSign).toEqualTypeOf<boolean>();
  }
  if (parsed?.extensionType === "keyUsage") {
    expectTypeOf(parsed.keyCertSign).toEqualTypeOf<boolean>();
  }
}

export async function crlTargetDetail(): Promise<void> {
  const res = await client.api.v1.crls[":targetId"].$get({ param: { targetId: "x" } });
  if (res.status !== 200) {
    return;
  }
  const body = await res.json();
  expectTypeOf(body.kind).toEqualTypeOf<CrlKind>();
  expectTypeOf(body.issuer.subjectCN).toEqualTypeOf<string | null>();
  // @ts-expect-error -- current may be null (an unpublished target)
  expectTypeOf(body.current.verifier).toBeString();
  if (body.current !== null) {
    expectTypeOf(body.current.summary.revokedCount).toBeNumber();
    expectTypeOf(body.current.summary.nextPublish).toEqualTypeOf<string | null>();
    expectTypeOf(body.current.tbsCertList.revokedCertificates.items).toBeArray();
  }
}

// The lists and the stats: arrays without an envelope, numbers without time fields.
type CertificateList = InferResponseType<typeof client.api.v1.certificates.$get, 200>;
type CrlTargetList = InferResponseType<typeof client.api.v1.crls.$get, 200>;
type Stats = InferResponseType<typeof client.api.v1.stats.$get, 200>;

expectTypeOf<CertificateList[number]["downloads"]>().toEqualTypeOf<string[]>();
// @ts-expect-error -- the list item has no detail fields
expectTypeOf<CertificateList[number]["tbsCertificate"]>().toBeObject();
expectTypeOf<CrlTargetList[number]["current"]>().toBeNullable();
// @ts-expect-error -- the list's current has no verifier (detail only)
expectTypeOf<NonNullable<CrlTargetList[number]["current"]>["verifier"]>().toBeString();
expectTypeOf<Stats["totalRevocations"]>().toEqualTypeOf<number | null>();
expectTypeOf<keyof Stats>().toEqualTypeOf<
  "certificates" | "targets" | "published" | "totalRevocations" | "derBytes"
>();
