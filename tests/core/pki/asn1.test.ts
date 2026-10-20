import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  Asn1TimeError,
  assertWellFormed,
  formatGeneralizedTime,
  readStrictTime,
} from "../../../src/core/pki/asn1.ts";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import { pkiError } from "../../helpers/pki.ts";

// Migrated from worker-aia-cdp@5b570aa:tests/worker/extension-parsers.test.ts:647 on the synthetic
// crls/root-ca/full-01.der instead of the live root CRL (D7). Its buildTBSCertList assertions move
// to slice 5a with the builders.

const CRL = fixture("crls/root-ca/full-01.der");

/** Octets from hex pairs separated by spaces. */
function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.trim().split(/\s+/), (pair) => Number.parseInt(pair, 16));
}

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
  // assertWellFormed checks decoded trees: the identifier and length octets are part of the rules.
  function decodedSequence(...value: asn1.BaseBlock[]): asn1.Sequence {
    return asn1.fromBER(new asn1.Sequence({ value }).toBER(false)).result as asn1.Sequence;
  }

  it("reports a time asn1js could not convert as Asn1TimeError", () => {
    // asn1js only sets block.error for a UTCTime without seconds; fromBER still succeeds.
    const sequence = decodedSequence(rawTime(23, "2605080000Z"));
    expect(sequence.valueBlock.value[0]?.error).not.toBe("");
    expect(() => assertWellFormed(sequence)).toThrow(Asn1TimeError);
  });

  it("reports any other decoder error as a plain Error", () => {
    const sequence = decodedSequence(new asn1.Integer({ value: 1 }));
    sequence.valueBlock.value[0]!.error = "synthetic decoder error";
    const run = () => assertWellFormed(sequence);
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

  // asn1js decodes all of these without an error (X.690 §8 and §10).
  it.each([
    ["the indefinite length", "30 80 02 01 01 00 00"],
    ["a long-form length below 128", "04 81 03 01 02 03"],
    ["a leading zero length octet", `04 82 00 80 ${"00 ".repeat(128)}`],
    ["a low tag number in the high-tag-number form", "1f 02 01 05"],
    ["a constructed OCTET STRING", "24 03 04 01 aa"],
    ["a constructed BIT STRING", "23 04 03 02 00 aa"],
    ["an empty INTEGER", "30 02 02 00"],
    ["an empty ENUMERATED", "0a 00"],
    ["an empty OBJECT IDENTIFIER", "06 00"],
    ["a BIT STRING without its unused-bits octet", "03 00"],
    ["an empty BOOLEAN", "01 00"],
    ["BER inside a SEQUENCE", "30 06 04 81 01 aa 05 00"],
    // An Extension's extnValue holds DER by definition (RFC 5280 §4.1), so it is checked too.
    ["BER inside an extension value", "30 0b 06 03 55 1d 0e 04 04 04 81 01 aa"],
  ])("rejects %s as a plain Error", (_, hex) => {
    const decoded = asn1.fromBER(bytes(hex));
    expect(decoded.offset).toBe(bytes(hex).byteLength);
    const run = () => assertWellFormed(decoded.result);
    expect(run).toThrow(/^Not DER: /);
    expect(run).not.toThrow(Asn1TimeError);
  });

  it("checks a time inside an extension value (AD CS Next CRL Publish)", () => {
    // Extension { 1.3.6.1.4.1.311.21.4, OCTET STRING { UTCTime "2605080000Z" } }
    const hex =
      "30 1a 06 09 2b 06 01 04 01 82 37 15 04 04 0d 17 0b 32 36 30 35 30 38 30 30 30 30 5a";
    expect(() => assertWellFormed(asn1.fromBER(bytes(hex)).result)).toThrow(Asn1TimeError);
  });

  // Only the contents of a constructed value and of an extension value are DER by definition: key
  // ids, hashes, keys and signatures are opaque, whatever asn1js made of them on speculation.
  it.each([
    ["a long-form length that is needed", `04 81 80 ${"00 ".repeat(128)}`],
    ["an OCTET STRING holding BER", "04 03 04 81 00"],
    ["an OCTET STRING holding an empty INTEGER", "04 02 02 00"],
    ["a BIT STRING holding a broken UTCTime", `03 15 00 17 12 ${"41 ".repeat(18)}`],
    // Subject Key Identifier { OCTET STRING (20) { 17 12 … } }: an opaque key id in a DER value.
    [
      "an SKI whose key id decodes as a broken UTCTime",
      `30 1d 06 03 55 1d 0e 04 16 04 14 17 12 ${"41 ".repeat(18)}`,
    ],
  ])("accepts %s", (_, hex) => {
    expect(() => assertWellFormed(asn1.fromBER(bytes(hex)).result)).not.toThrow();
  });
});

describe("formatGeneralizedTime", () => {
  it("writes YYYYMMDDHHMMSSZ in UTC, dropping milliseconds", () => {
    expect(formatGeneralizedTime(new Date("2026-01-04T00:00:00Z"))).toBe("20260104000000Z");
    expect(formatGeneralizedTime(new Date("2026-01-03T11:50:07.999Z"))).toBe("20260103115007Z");
    expect(formatGeneralizedTime(new Date("2026-01-03T23:50:00+08:00"))).toBe("20260103155000Z");
  });

  it("is what readStrictTime reads back, for every fixture CRL's thisUpdate", () => {
    for (const crl of manifest.crls) {
      const date = new Date(crl.thisUpdate);
      const text = formatGeneralizedTime(date);
      expect(readStrictTime(decodedTime(24, text)).date, crl.file).toEqual(date);
    }
  });

  it("keeps a fixed width over 0000–9999, so string order is time order", () => {
    const dates = [
      "0000-01-01T00:00:00Z",
      "0999-12-31T23:59:59Z",
      "1999-12-31T23:59:59Z",
      "2026-01-04T00:00:00Z",
      "2026-01-04T00:00:01Z",
      "9999-12-31T23:59:59Z",
    ].map((iso) => new Date(iso));
    const texts = dates.map(formatGeneralizedTime);
    expect(texts.every((text) => /^\d{14}Z$/.test(text))).toBe(true);
    expect(texts.toSorted()).toEqual(texts);
  });

  it.each([
    ["an invalid date", new Date(Number.NaN)],
    ["year 10000", new Date("+010000-01-01T00:00:00Z")],
    ["a negative year", new Date("-000001-01-01T00:00:00Z")],
  ])("throws RangeError for %s", (_case, date) => {
    expect(() => formatGeneralizedTime(date)).toThrow(RangeError);
  });
});
