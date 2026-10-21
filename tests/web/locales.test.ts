// The message files (implementation slice 5b step 8): zh-CN is a complete translation of en (same
// keys, same placeholders, Chinese text where it matters), every error code the client can meet
// has a message in both, and the keys the old en.json carried for removed UI are gone.
import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_CODES, ERROR_CODES } from "@/client/error-codes";
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
const CJK = /[一-鿿]/;

/** The named placeholders of a message: "{count} items" → ["count"]. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("locales", () => {
  it("have the same keys in en and zh-CN, none empty", () => {
    expect([...ZH.keys()].sort()).toEqual([...EN.keys()].sort());
    for (const [key, message] of [...EN, ...ZH]) {
      expect(message.trim(), key).not.toBe("");
    }
  });

  it("use the same placeholders in both languages", () => {
    for (const [key, message] of EN) {
      expect(placeholders(ZH.get(key)!), key).toEqual(placeholders(message));
    }
  });

  it("have a message for every error code of the client, and for unknown codes", () => {
    for (const code of [...ERROR_CODES, ...CLIENT_ERROR_CODES, "unknown"]) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`errors.${code}`), code).toBeTruthy();
      }
    }
    expect(placeholders(EN.get("errors.unknown")!)).toEqual(["code"]);
  });

  it("translate the sentences of zh-CN, not copy them", () => {
    const sentences = [...EN].filter(([, message]) => /[a-z]{3,} [a-z]{3,}/.test(message));
    expect(sentences.length).toBeGreaterThan(50);
    for (const [key] of sentences) {
      expect(ZH.get(key), key).toMatch(CJK);
    }
  });

  it("no longer carry the keys of the removed UI", () => {
    for (const key of [
      "app.title",
      "status.active",
      "extension.unknownType",
      "upload.errors.noValidContent",
      "upload.errors.readFile",
      "upload.helpers.der",
      "pages.placeholder",
    ]) {
      expect(EN.has(key), key).toBe(false);
    }
    for (const prefix of ["upload.status.", "certificateCard.", "crlCard."]) {
      expect([...EN.keys()].filter((key) => key.startsWith(prefix))).toEqual([]);
    }
  });
});
