// The message files (implementation slice 5b step 8): zh-CN is a complete translation of en (same
// keys, same placeholders, nothing left in English but acronyms), every error code and upload
// reason the client can meet has a message in both, and the keys the old en.json carried for
// removed UI are gone.
import { describe, expect, it } from "vitest";
import { PKI_PARSE_REASONS } from "../../src/core/pki/errors.ts";
import { CLIENT_ERROR_CODES, ERROR_CODES } from "@/client/error-codes";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";
import { UPLOAD_REASONS } from "@/utils/errors";

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
/** The only texts zh-CN may share with en. */
const ACRONYMS = new Set(["CA", "CPS", "DNS", "IP", "PEM", "URI", "X.400"]);

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

  it("have a reason message for every details.reason the server sends with an upload failure", () => {
    // invalid_crl: the parse reasons and the signature check of src/core/publish.ts;
    // issuer_not_found: missing_aki (implementation §2.6).
    const server = [...PKI_PARSE_REASONS, "signature_algorithm_mismatch", "missing_aki"];
    expect([...UPLOAD_REASONS].sort()).toEqual(server.sort());
    for (const reason of UPLOAD_REASONS) {
      for (const messages of [EN, ZH]) {
        expect(messages.get(`upload.reasons.${reason}`), reason).toBeTruthy();
      }
    }
  });

  it("translate every message of zh-CN but acronyms, and the sentences into Chinese", () => {
    for (const [key, message] of EN) {
      if (!ACRONYMS.has(message)) {
        expect(ZH.get(key), key).not.toBe(message);
      }
    }
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
