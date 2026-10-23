// The UI's Content-Security-Policy: every response of the one app carries the policy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testDeps } from "../helpers/app.ts";

const INDEX_HTML = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");

describe("Content-Security-Policy", () => {
  it("is on UI, JSON and download-prefix responses", async () => {
    const app = createApp(
      testDeps({
        ui: () =>
          new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      })
    );
    const policies = new Set<string | null>();
    for (const [method, path, contentType] of [
      ["GET", "/", /^text\/html/],
      ["HEAD", "/no/such/page", /^text\/html/],
      ["GET", "/api/v1/health", /^application\/json/],
      ["GET", "/crl/missing.crl", /^text\/plain/],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.headers.get("Content-Type"), path).toMatch(contentType);
      policies.add(res.headers.get("Content-Security-Policy"));
      expect(res.headers.get("Content-Security-Policy-Report-Only"), path).toBeNull();
      expect(res.headers.get("Strict-Transport-Security"), path).toBeNull();
    }
    // One policy for all of them, which allows only same-origin scripts.
    expect(policies.size).toBe(1);
    expect([...policies][0]).toContain("script-src 'self';");
  });
});
