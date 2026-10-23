// The message files: en and zh-CN have the same keys and placeholders, and every error code and
// upload reason the client can meet has a message in both (utils/errors.ts falls back to
// errors.unknown or the bare reason without one).
import { describe, expect, it } from "vitest";
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
import { ERROR_CODES } from "../../src/http/schemas.ts";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";

type Messages = Record<string, unknown>;

/** "a.b.c" → message, for every leaf. */
function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = `${prefix}${key}`;
    if (typeof value === "string") {
      result.set(path, value);
    } else {
      for (const [inner, text] of flatten(value as Messages, `${path}.`)) {
        result.set(inner, text);
      }
    }
  }
  return result;
}

const EN = flatten(en);
const ZH = flatten(zhCN);

/** The named placeholders of a message: "{count} items" → ["count"]. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("locales", () => {
  it("have the same keys and placeholders in en and zh-CN, none empty", () => {
    expect([...ZH.keys()].sort()).toEqual([...EN.keys()].sort());
    for (const [key, message] of EN) {
      expect(message.trim(), key).not.toBe("");
      expect(ZH.get(key)!.trim(), key).not.toBe("");
      expect(placeholders(ZH.get(key)!), key).toEqual(placeholders(message));
    }
  });

  it("have a message for every error code of the client, and for unknown codes", () => {
    // The server's codes, the two of client/errors.ts and the fallback.
    for (const code of [...ERROR_CODES, "network", "invalid_response", "unknown"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`errors.${code}`), code).toBeTruthy();
      }
    }
  });

  it("have a reason message for every details.reason the server sends with an upload failure", () => {
    // invalid_crl: the parse reasons and the signature check; issuer_not_found: missing_aki.
    for (const reason of [...PKI_PARSE_REASONS, "signature_algorithm_mismatch", "missing_aki"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`upload.reasons.${reason}`), reason).toBeTruthy();
      }
    }
  });
});
