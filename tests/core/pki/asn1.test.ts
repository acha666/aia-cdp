import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { Asn1TimeError, assertWellFormed, readStrictTime } from "../../../src/core/pki/asn1.ts";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import { pkiError } from "../../helpers/pki.ts";

// Migrated from worker-aia-cdp@5b570aa:tests/worker/extension-parsers.test.ts:647 on the synthetic
// crls/root-ca/full-01.der instead of the live root CRL (D7). Its buildTBSCertList assertions move
// to slice 5a with the builders.

const CRL = fixture("crls/root-ca/full-01.der");

/** A primitive with arbitrary content bytes; asn1js time classes would re-encode their fields. */
function rawTime(tagNumber: 23 | 24, raw: string): asn1.Primitive {
  return new asn1.Primitive({
    idBlock: { tagClass: 1, tagNumber },
    valueHex: new TextEncoder().encode(raw).buffer,
  });
}

/** How asn1js itself decodes such a value: a UTCTime / GeneralizedTime instance. */
function decodedTime(tagNumber: 23 | 24, raw: string): asn1.BaseBlock {
  return asn1.fromBER(rawTime(tagNumber, raw).toBER(false)).result;
}

/** root-ca/full-01 with its thisUpdate replaced by `time` (the signature no longer matches). */
function withThisUpdate(time: asn1.BaseBlock): ArrayBuffer {
  const crl = parseCRL(CRL);
  crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date("2026-05-08T00:00:00Z") });
  // PKIjs types CertificateRevocationList.toSchema() as any.
  const schema = crl.toSchema(true) as asn1.Sequence;
  const tbs = schema.valueBlock.value[0] as asn1.Sequence;
  // thisUpdate is the first UTCTime of the TBS (nextUpdate follows it).
  const index = tbs.valueBlock.value.findIndex((block) => block instanceof asn1.UTCTime);
  tbs.valueBlock.value[index] = time;
  return schema.toBER(false);
}

describe("strict RFC 5280 times", () => {
  it.each(["ZZZZZZZZZZZZZ", "260230000000Z", "2605080000Z", "260508000000+0800"])(
    "rejects the UTCTime %j as a time error instead of inventing a date",
    async (raw) => {
      expect(await pkiError(() => parseCRL(withThisUpdate(rawTime(23, raw))))).toEqual({
        kind: "crl",
        reason: "time",
      });
    }
  );

  it("rejects a GeneralizedTime with fractional seconds", async () => {
    expect(
      await pkiError(() => parseCRL(withThisUpdate(rawTime(24, "20260508000000.5Z"))))
    ).toEqual({ kind: "crl", reason: "time" });
  });

  it("accepts a GeneralizedTime in the RFC 5280 form", () => {
    const crl = parseCRL(withThisUpdate(rawTime(24, "20260508000000Z")));
    expect(crl.thisUpdate.type).toBe(1);
    expect(crl.thisUpdate.value.toISOString()).toBe("2026-05-08T00:00:00.000Z");
  });

  it("rejects crls/issuing-ca-1/full-bad-time.der (UTCTime without seconds, valid signature)", async () => {
    expect(await pkiError(() => parseCRL(fixture("crls/issuing-ca-1/full-bad-time.der")))).toEqual({
      kind: "crl",
      reason: "time",
    });
  });

  it("pivots two-digit UTCTime years at 50", () => {
    expect(readStrictTime(decodedTime(23, "491231235959Z")).date).toEqual(
      new Date("2049-12-31T23:59:59Z")
    );
    expect(readStrictTime(decodedTime(23, "500101000000Z")).date).toEqual(
      new Date("1950-01-01T00:00:00Z")
    );
    // PKIjs (through asn1js) agrees, so the date callers read is the validated one.
    expect(parseCRL(withThisUpdate(rawTime(23, "500101000000Z"))).thisUpdate.value).toEqual(
      new Date("1950-01-01T00:00:00Z")
    );
  });

  it("readStrictTime returns the type, the raw text and the date", () => {
    const utc = new asn1.UTCTime({ valueDate: new Date("1999-12-31T23:59:59Z") });
    expect(readStrictTime(utc)).toEqual({
      type: "utcTime",
      raw: "991231235959Z",
      date: new Date("1999-12-31T23:59:59Z"),
    });
    expect(readStrictTime(decodedTime(24, "20991231235959Z"))).toEqual({
      type: "generalizedTime",
      raw: "20991231235959Z",
      date: new Date("2099-12-31T23:59:59Z"),
    });
  });

  it("readStrictTime throws Asn1TimeError", () => {
    expect(() => readStrictTime(new asn1.Integer({ value: 1 }))).toThrow(Asn1TimeError);
    expect(() => readStrictTime(new asn1.Integer({ value: 1 }))).toThrow(/not a time/);
    for (const raw of ["260230000000Z", "2605080000Z", "260508000000+0800"]) {
      expect(() => readStrictTime(decodedTime(23, raw)), raw).toThrow(Asn1TimeError);
    }
    expect(() => readStrictTime(decodedTime(24, "20260508000000.5Z"))).toThrow(Asn1TimeError);
  });
});

describe("assertWellFormed", () => {
  it("reports a time asn1js could not convert as Asn1TimeError", () => {
    // asn1js only sets block.error for a UTCTime without seconds; fromBER still succeeds.
    const time = decodedTime(23, "2605080000Z");
    expect(time.error).not.toBe("");
    expect(() => assertWellFormed(new asn1.Sequence({ value: [time] }))).toThrow(Asn1TimeError);
  });

  it("reports any other decoder error as a plain Error", () => {
    const integer = new asn1.Integer({ value: 1 });
    integer.error = "synthetic decoder error";
    const run = () => assertWellFormed(new asn1.Sequence({ value: [integer] }));
    expect(run).toThrow(/ASN\.1 decode error: synthetic decoder error/);
    expect(run).not.toThrow(Asn1TimeError);
  });

  // full-bad-time is the only fixture CRL whose first upload is invalid_crl.
  it.each(manifest.crls.filter((crl) => crl.expect !== "invalid_crl").map((crl) => crl.file))(
    "accepts %s",
    (file) => {
      expect(() => assertWellFormed(asn1.fromBER(fixture(file)).result)).not.toThrow();
    }
  );
});
