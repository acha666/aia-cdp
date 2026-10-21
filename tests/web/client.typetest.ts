// Compile-time checks of the web client (implementation slice 5a step 10): type-checked by
// `pnpm run typecheck:web` (tsconfig.web.json includes tests/web/), never run (not a *.test.ts).
// Each @ts-expect-error must stay live: if a type widened to any or string, the line would compile
// and the directive itself would fail.
import { expectTypeOf } from "vitest";
import type {
  ERROR_CODES as SERVER_ERROR_CODES,
  ErrorCode as ServerErrorCode,
} from "../../src/http/schemas.ts";
import { api } from "@/client/api";
import type { ERROR_CODES, ErrorCode } from "@/client/error-codes";
import { ApiError, unwrap } from "@/client/errors";
import type {
  CertificateDetail,
  CertificateList,
  CrlTargetDetail,
  CrlTargetList,
  ExtensionType,
  PublishedCrl,
  Stats,
} from "@/client/types";

// The web's runtime list is the server's: the same union both ways and the same length, so neither
// side has a code the other lacks, and the web list has no duplicate.
expectTypeOf<ErrorCode>().toEqualTypeOf<ServerErrorCode>();
expectTypeOf<ServerErrorCode>().toEqualTypeOf<ErrorCode>();
expectTypeOf<(typeof ERROR_CODES)["length"]>().toEqualTypeOf<
  (typeof SERVER_ERROR_CODES)["length"]
>();
// @ts-expect-error -- a client code is not a v1 code: the unions are literal, not string
expectTypeOf<ErrorCode | "network">().toEqualTypeOf<ServerErrorCode>();

expectTypeOf<ApiError["code"]>().toEqualTypeOf<string>();
expectTypeOf<ApiError["status"]>().toEqualTypeOf<number>();

// unwrap returns the 200 (or 201) body of each route, never an error body.
export async function bodies(file: File): Promise<void> {
  const v1 = api.api.v1;

  const certificates = await unwrap(await v1.certificates.$get());
  expectTypeOf(certificates).toEqualTypeOf<CertificateList>();
  // @ts-expect-error -- typed from the route's 200 schema, not any
  expectTypeOf(certificates).toBeAny();
  expectTypeOf(certificates[0]!.label).toEqualTypeOf<string | null>();

  const certificate = await unwrap(await v1.certificates[":id"].$get({ param: { id: "x" } }));
  expectTypeOf(certificate).toEqualTypeOf<CertificateDetail>();
  // @ts-expect-error -- an error envelope is not part of the result
  expectTypeOf(certificate).toHaveProperty("error");
  const value = certificate.tbsCertificate.extensions?.items[0]?.parsed;
  if (value?.extensionType === "basicConstraints") {
    expectTypeOf(value.cA).toEqualTypeOf<boolean>();
  }
  expectTypeOf<NonNullable<typeof value>["extensionType"]>().toEqualTypeOf<ExtensionType>();

  const targets = await unwrap(await v1.crls.$get());
  expectTypeOf(targets).toEqualTypeOf<CrlTargetList>();
  expectTypeOf(targets[0]!.current?.summary.nextPublish).toEqualTypeOf<string | null | undefined>();

  const target = await unwrap(await v1.crls[":targetId"].$get({ param: { targetId: "x" } }));
  expectTypeOf(target).toEqualTypeOf<CrlTargetDetail>();
  // @ts-expect-error -- current is null while nothing is published
  expectTypeOf(target.current).toEqualTypeOf<NonNullable<CrlTargetDetail["current"]>>();
  expectTypeOf(target.current?.tbsCertList.revokedCertificates.count).toEqualTypeOf<
    number | undefined
  >();

  const stats = await unwrap(await v1.stats.$get());
  expectTypeOf(stats).toEqualTypeOf<Stats>();
  expectTypeOf(stats.totalRevocations).toEqualTypeOf<number | null>();

  const published = await unwrap(await v1.crls.$post({ form: { crl: file } }));
  expectTypeOf(published).toEqualTypeOf<PublishedCrl>();
  expectTypeOf(published.outcome).toEqualTypeOf<"created" | "updated" | "unchanged">();
}

export function errors(error: unknown): void {
  if (error instanceof ApiError) {
    expectTypeOf(error.details).toEqualTypeOf<unknown>();
  }
}
