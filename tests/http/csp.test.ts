// The UI's Content-Security-Policy: the hash that allows the pre-paint theme script is that of the
// script in src/web/index.html, and both runtimes' UI responses carry the policy, since it comes
// from the one app.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { INLINE_SCRIPT_HASHES } from "../../src/http/csp.ts";
import { CSP_HEADER, testDeps } from "../helpers/app.ts";

const INDEX_HTML = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
const HEX64 = "0123456789abcdef".repeat(4);
const UUID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";

/** A script's CSP hash source, newlines as the HTML parser leaves them (LF). */
function sha256Source(text: string): string {
  const digest = createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8");
  return `'sha256-${digest.digest("base64")}'`;
}

describe("inline script hash", () => {
  it("is the sha256 of the only inline script of src/web/index.html", () => {
    const inline = [...INDEX_HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attributes]) => !attributes?.includes("src="))
      .map(([, , text]) => text ?? "");
    expect(inline).toHaveLength(1);
    expect(inline[0]).toContain('localStorage.getItem("theme-preference")');
    expect(INLINE_SCRIPT_HASHES).toEqual(inline.map(sha256Source));
  });
});

describe("policy", () => {
  const app = createApp(
    testDeps({
      ui: () =>
        new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    })
  );

  it.each(["/", `/certificates/${HEX64}`, `/crls/${UUID}`, "/no/such/page"])(
    "is on the UI response for %s",
    async (path) => {
      for (const method of ["GET", "HEAD"]) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
        expect(res.headers.get("Content-Security-Policy")).toBe(CSP_HEADER);
        expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
      }
    }
  );

  it("is on JSON and download-prefix answers too, which stay what they were", async () => {
    const health = await app.request("/api/v1/health");
    expect(health.headers.get("Content-Security-Policy")).toBe(CSP_HEADER);
    expect(health.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await health.json()).toMatchObject({ status: "degraded" });

    const miss = await app.request("/crl/missing.crl");
    expect(miss.headers.get("Content-Security-Policy")).toBe(CSP_HEADER);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe("Not Found");
  });
});
