// en and zh-CN keep the same keys and placeholders. Client failures, the unknown-code fallback
// and every upload parse reason have messages in both languages.
import { describe, expect, it } from "vitest";
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";

type Messages = Record<string, unknown>;

/** ["a.b.c", message] for every leaf. */
const flatten = (messages: Messages, prefix = ""): [string, string][] =>
  Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value]]
      : flatten(value as Messages, `${prefix}${key}.`)
  );

const EN = new Map(flatten(en));
const ZH = new Map(flatten(zhCN));

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

  it("have messages for client failures and unknown codes", () => {
    // Codes created by client/errors.ts and the fallback; locale parity covers server messages.
    for (const code of ["network", "invalid_response", "unknown"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`errors.${code}`), code).toBeTruthy();
      }
    }
  });

  it("have a reason message for every details.reason the server sends with an upload failure", () => {
    // invalid_certificate / invalid_crl: PKI_PARSE_REASONS; issuer_not_found: missing_aki.
    for (const reason of [...PKI_PARSE_REASONS, "missing_aki"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`upload.reasons.${reason}`), reason).toBeTruthy();
      }
    }
  });
});
