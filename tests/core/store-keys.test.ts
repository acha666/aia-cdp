import { describe, expect, it } from "vitest";
import { assertStoreKey, assertStorePrefix } from "../../src/core/store.ts";
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
