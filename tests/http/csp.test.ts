// The UI's Content-Security-Policy: the hash that allows the pre-paint theme script is that of the
// script in src/web/index.html, and every response of the one app carries the policy.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { INLINE_SCRIPT_HASHES } from "../../src/http/csp.ts";
import { CSP_HEADER, testDeps } from "../helpers/app.ts";

const INDEX_HTML = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");

/** A script's CSP hash source, newlines as the HTML parser leaves them (LF). */
function sha256Source(text: string): string {
  const digest = createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8");
  return `'sha256-${digest.digest("base64")}'`;
}

describe("Content-Security-Policy", () => {
  it("allows the sha256 of the only inline script of src/web/index.html", () => {
    const inline = [...INDEX_HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attributes]) => !attributes?.includes("src="))
      .map(([, , text]) => text ?? "");
    expect(inline).toHaveLength(1);
    expect(inline[0]).toContain('localStorage.getItem("theme-preference")');
    expect(INLINE_SCRIPT_HASHES).toEqual(inline.map(sha256Source));
  });

  it("is on UI, JSON and download-prefix responses", async () => {
    const app = createApp(
      testDeps({
        ui: () =>
          new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      })
    );
    for (const [method, path, contentType] of [
      ["GET", "/", /^text\/html/],
      ["HEAD", "/no/such/page", /^text\/html/],
      ["GET", "/api/v1/health", /^application\/json/],
      ["GET", "/crl/missing.crl", /^text\/plain/],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.headers.get("Content-Type"), path).toMatch(contentType);
      expect(res.headers.get("Content-Security-Policy"), path).toBe(CSP_HEADER);
      expect(res.headers.get("Content-Security-Policy-Report-Only"), path).toBeNull();
      expect(res.headers.get("Strict-Transport-Security"), path).toBeNull();
    }
  });
});
