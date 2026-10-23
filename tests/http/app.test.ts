// Routing rules shared by both runtimes: the /api prefix, the UI fallback, 405 and the 500
// envelope. The download prefixes are tests/http/downloads.test.ts.
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { logRecords, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";

const HEX64 = "0123456789abcdef".repeat(4);
const UUID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const INDEX_HTML = "<!doctype html><title>UI</title>";
const SCRIPT = "export const ui = 1;";

/**
 * A real Response whose headers are immutable, as every Workers ASSETS binding response is:
 * undici guards the headers of a fetch() response, data: URLs included (no network).
 */
function frozen(contentType: string, body: string): Promise<Response> {
  return fetch(`data:${contentType},${encodeURIComponent(body)}`);
}

/** createApp with a deps.ui that answers index.html for every path, as the SPA assets do. */
function setup(overrides: TestOverrides = {}) {
  const requests: Request[] = [];
  const deps = testDeps({
    ui: (req) => {
      requests.push(req);
      return frozen("text/html;charset=utf-8", INDEX_HTML);
    },
    ...overrides,
  });
  return { app: createApp(deps), deps, requests };
}

describe("/api", () => {
  it.each(["/api", "/api/", "/api/v1/missing"])("GET %s → JSON 404 not_found", async (path) => {
    const { app, requests } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    expect(requests).toEqual([]);
  });

  it("answers another method on a route with the 405 envelope and Allow", async () => {
    const { app } = setup();
    const res = await app.request("/api/v1/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
  });

  it("turns an unexpected exception into the 500 envelope; the error only goes to the log", async () => {
    const { app, deps } = setup();
    // Registered before the first request: the router is frozen afterwards.
    app.get("/api/v1/test/boom", () => {
      throw new Error("hunter2");
    });
    const res = await app.request("/api/v1/test/boom");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal", message: "Internal server error" },
    });
    expect(text).not.toContain("hunter2");
    expect(logRecords(deps).filter((line) => line.msg === "unhandled_error")).toMatchObject([
      { level: "error", path: "/api/v1/test/boom", error: { message: "hunter2" } },
    ]);
  });

  it("never logs tokens or the query string", async () => {
    const { app, deps } = setup();
    await app.request("/api/v1/health?token=s3cret", {
      headers: { Authorization: "Bearer s3cret" },
    });
    await app.request("/api/v1/missing?token=s3cret", {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
      body: "s3cret",
    });
    expect(deps.lines).toHaveLength(2);
    expect(deps.lines.join("\n")).not.toContain("s3cret");
    expect(logRecords(deps).map((line) => line.path)).toEqual([
      "/api/v1/health",
      "/api/v1/missing",
    ]);
  });
});

describe("UI fallback", () => {
  it.each(["/", `/certificates/${HEX64}`, `/crls/${UUID}`, "/assets/foo"])(
    "GET and HEAD %s → the ui's answer, no-cache",
    async (path) => {
      const { app, requests } = setup();
      for (const method of ["GET", "HEAD"]) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
        expect(await res.text()).toBe(method === "GET" ? INDEX_HTML : "");
      }
      expect(requests.map((req) => req.method)).toEqual(["GET", "HEAD"]);
    }
  );

  it("marks hashed assets immutable", async () => {
    const { app } = setup({ ui: () => frozen("text/javascript", SCRIPT) });
    const res = await app.request("/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(SCRIPT);
  });

  it.each(["/assets/missing.js", "/missing.png"])(
    "GET %s answered with the SPA's text/html → text/plain 404",
    async (path) => {
      const { app } = setup();
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe("Not Found");
    }
  );

  it("turns a ui 404 into the text/plain 404", async () => {
    const { app } = setup({
      ui: () =>
        new Response("<p>gone</p>", { status: 404, headers: { "Content-Type": "text/html" } }),
    });
    const res = await app.request("/certificates/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
  });

  it.each([
    ["POST", "/crls/abc"],
    ["PUT", "/"],
  ])("%s %s → text 404, not 405, without asking the ui", async (method, path) => {
    const { app, requests } = setup();
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
    expect(requests).toEqual([]);
  });

  it.each(["/", "/assets/index-abc.js"])(
    "without an injected ui, GET %s → text 404",
    async (path) => {
      const res = await createApp(testDeps()).request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await res.text()).toBe("Not Found");
    }
  );
});
