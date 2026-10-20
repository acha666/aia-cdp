import { describe, expect, it } from "vitest";
import { formatGeneralizedTime } from "../../src/core/pki/asn1.ts";
import { crlBlobKey, crlVersionName } from "../../src/core/publish.ts";
import { assertStoreKey, assertStorePrefix } from "../../src/core/store.ts";
import { manifest } from "../fixtures/pki.ts";
import { INVALID_KEYS, INVALID_PREFIXES } from "../storage/conformance.ts";

const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const targetId = "0d5b6f7e-3c1a-4e2b-9a8f-6b7c8d9e0f1a";

describe("assertStoreKey", () => {
  // The four key classes of plan §5.1.
  it.each([
    "config.json",
    "catalog.json",
    `blobs/certificates/${sha256}.der`,
    `blobs/crls/${targetId}/20260104000000Z-3-${sha256}.der`,
    `blobs/crls/${targetId}/20260104000000Z-none-${sha256}.der`,
    `history/${targetId}/20260104000000Z-3-${sha256}.json`,
  ])("accepts %j", (key) => {
    expect(() => assertStoreKey(key)).not.toThrow();
  });

  it.each(INVALID_KEYS)("rejects %j", (key) => {
    expect(() => assertStoreKey(key)).toThrow(TypeError);
  });

  it("names the offending key", () => {
    expect(() => assertStoreKey("../a")).toThrow('Invalid store key: "../a"');
  });
});

describe("assertStorePrefix", () => {
  it.each(["", "blobs/", "blobs/certificates/", `blobs/crls/${targetId}/`, `history/${targetId}/`])(
    "accepts %j",
    (prefix) => {
      expect(() => assertStorePrefix(prefix)).not.toThrow();
    }
  );

  it.each(INVALID_PREFIXES)("rejects %j", (prefix) => {
    expect(() => assertStorePrefix(prefix)).toThrow(TypeError);
  });

  it("names the offending prefix", () => {
    expect(() => assertStorePrefix("blobs")).toThrow('Invalid store prefix: "blobs"');
  });
});

// The CRL blob key (plan §5.1, slice 4 step 2) from the function itself, on every fixture CRL.
describe("crlBlobKey", () => {
  const summaryOf = (crl: (typeof manifest.crls)[number]) => ({
    thisUpdate: new Date(crl.thisUpdate).toISOString(),
    crlNumber: crl.crlNumber,
  });

  it.each(manifest.crls.map((crl) => [crl.file, crl] as const))(
    "%s: blobs/crls/<target>/<thisUpdate>-<number|none>-<sha256>.der, a valid store key",
    (_file, crl) => {
      const summary = summaryOf(crl);
      const key = crlBlobKey(targetId, summary, crl.sha256);
      const [prefix, name] = [`blobs/crls/${targetId}/`, crlVersionName(summary, crl.sha256)];
      expect(key).toBe(`${prefix}${name}.der`);
      const [time, number, digest, ...rest] = name.split("-");
      expect(rest).toEqual([]);
      expect(time).toBe(formatGeneralizedTime(new Date(crl.thisUpdate)));
      expect(number).toBe(crl.crlNumber ?? "none");
      expect(digest).toBe(crl.sha256);
      expect(() => assertStoreKey(key)).not.toThrow();
    }
  );

  it("sorts a target's keys by thisUpdate", () => {
    const crls = manifest.crls.toSorted(
      (a, b) => Date.parse(a.thisUpdate) - Date.parse(b.thisUpdate)
    );
    const keys = crls.map((crl) => crlBlobKey(targetId, summaryOf(crl), crl.sha256));
    const times = (list: string[]) => list.map((key) => key.split("/")[3]?.slice(0, 15));
    expect(times(keys.toSorted())).toEqual(times(keys));
  });

  it("does not depend on milliseconds in thisUpdate", () => {
    const crl = manifest.crls[0]!;
    const withMs = { thisUpdate: new Date(crl.thisUpdate).toISOString(), crlNumber: "1" };
    const withoutMs = { thisUpdate: crl.thisUpdate, crlNumber: "1" };
    expect(crlBlobKey(targetId, withoutMs, sha256)).toBe(crlBlobKey(targetId, withMs, sha256));
  });
});
