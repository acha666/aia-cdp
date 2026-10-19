// Routing rules shared by both runtimes (implementation slice 1 step 4, plan §4.4, §7.3): reserved
// prefixes, the UI fallback, 405, the error envelope, secureHeaders and the request log.
// Rewrite of the first two cases of worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts.
import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { ApiError } from "../../src/http/errors.ts";
import { logRecords, testDeps } from "../helpers/app.ts";
import type { LogLine, TestOverrides } from "../helpers/app.ts";

const HEX64 = "0123456789abcdef".repeat(4);
const UUID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const INDEX_HTML = "<!doctype html><title>UI</title>";
const SCRIPT = "export const ui = 1;";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * A real Response whose headers are immutable, as every workerd ASSETS binding response is:
 * undici guards the headers of a fetch() response, data: URLs included (no network).
 */
function frozen(contentType: string, body: string): Promise<Response> {
  return fetch(`data:${contentType},${encodeURIComponent(body)}`);
}

/** ASSETS with not_found_handling "single-page-application": index.html for every path. */
function spa(): Promise<Response> {
  return frozen("text/html;charset=utf-8", INDEX_HTML);
}

/** A SPA deps.ui stand-in that records each request it gets and each response it returns. */
function uiStub() {
  const requests: Request[] = [];
  const responses: Response[] = [];
  return {
    requests,
    responses,
    ui: async (req: Request) => {
      requests.push(req);
      const res = await spa();
      responses.push(res);
      return res;
    },
  };
}

/** createApp with the SPA stand-in as deps.ui, unless `overrides` brings its own ui. */
function setup(overrides: TestOverrides = {}) {
  const stub = uiStub();
  const deps = testDeps({ ui: stub.ui, ...overrides });
  return { app: createApp(deps), deps, stub };
}

function requestLines(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => line.msg === "request");
}

describe("reserved prefixes", () => {
  it.each(["/api", "/api/", "/api/v1/missing"])("GET %s → JSON 404 not_found", async (path) => {
    const { app, stub } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    expect(stub.requests).toEqual([]);
  });

  it.each([
    ["GET", "/ca/x.crt"],
    ["POST", "/ca/x.crt"],
    ["GET", "/crl/missing.crl"],
    ["POST", "/crl/missing.crl"],
    ["GET", "/dcrl/x.crl"],
    ["POST", "/dcrl/x.crl"],
  ])("%s %s → text/plain 404 Not Found", async (method, path) => {
    const { app, stub } = setup();
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("Not Found");
    expect(stub.requests).toEqual([]);
  });
});

describe("UI fallback", () => {
  it("is fed responses with immutable headers, like the Workers ASSETS binding", async () => {
    const res = await spa();
    expect(() => res.headers.set("Cache-Control", "no-cache")).toThrow(TypeError);
  });

  it.each(["/", `/certificates/${HEX64}`, `/crls/${UUID}`])(
    "GET %s → the ui response, copied, no-cache",
    async (path) => {
      const { app, stub } = setup();
      const req = new Request(`http://localhost${path}`);
      const res = await app.request(req);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toBe(req);
      expect(res).not.toBe(stub.responses[0]);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(await res.text()).toBe(INDEX_HTML);
    }
  );

  it.each(["/", `/certificates/${HEX64}`, `/crls/${UUID}`])(
    "HEAD %s → handed to the ui as HEAD, no-cache, no body",
    async (path) => {
      const { app, stub } = setup();
      const req = new Request(`http://localhost${path}`, { method: "HEAD" });
      const res = await app.request(req);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toBe(req);
      expect(stub.requests[0]?.method).toBe("HEAD");
      expect(res).not.toBe(stub.responses[0]);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(await res.text()).toBe("");
    }
  );

  it("marks hashed assets immutable", async () => {
    const { app } = setup({ ui: () => frozen("text/javascript", SCRIPT) });
    const res = await app.request("/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(await res.text()).toBe(SCRIPT);
  });

  it.each(["/assets/missing.js", "/missing.png"])(
    "GET %s answered with the SPA's text/html → text/plain 404",
    async (path) => {
      const { app, stub } = setup();
      const res = await app.request(path);
      expect(stub.requests).toHaveLength(1);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe("Not Found");
    }
  );

  it("passes text/html through for a path ending in .html", async () => {
    const { app } = setup();
    const res = await app.request("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX_HTML);
  });

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

  it("passes a 304 through with the rewritten Cache-Control", async () => {
    const { app } = setup({
      ui: () => new Response(null, { status: 304, headers: { ETag: '"abc"' } }),
    });
    const res = await app.request("/assets/index-abc.js", {
      headers: { "If-None-Match": '"abc"' },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE);
  });

  it("passes a redirect with immutable headers through (Workers html_handling)", async () => {
    const { app } = setup({ ui: () => Response.redirect("http://localhost/", 307) });
    const res = await app.request("/certificates/");
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("http://localhost/");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it.each([
    ["POST", "/crls/abc"],
    ["PUT", "/"],
  ])("%s %s → text 404, not 405, without asking the ui", async (method, path) => {
    const { app, stub } = setup();
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
    expect(stub.requests).toEqual([]);
  });

  it.each(["/", `/crls/${UUID}`, "/assets/index-abc.js"])(
    "without an injected ui, GET %s → text 404",
    async (path) => {
      const app = createApp(testDeps());
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await res.text()).toBe("Not Found");
    }
  );
});

describe("method not allowed", () => {
  it.each(["POST", "DELETE"])("%s /api/v1/health → 405 envelope with Allow", async (method) => {
    const { app, stub } = setup();
    const res = await app.request("/api/v1/health", { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
    expect(stub.requests).toEqual([]);
  });
});

describe("errors", () => {
  it("turns an unexpected exception into the 500 envelope; the stack only goes to the log", async () => {
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

    const records = logRecords(deps);
    const unhandled = records.filter((line) => line.msg === "unhandled_error");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toMatchObject({
      level: "error",
      method: "GET",
      path: "/api/v1/test/boom",
      error: { name: "Error", message: "hunter2" },
    });
    expect(JSON.stringify(unhandled[0])).toMatch(/"stack":"Error: hunter2\\n\s+at /);
    expect(requestLines(records)).toMatchObject([{ status: 500 }]);
  });

  it("maps ApiError onto the envelope with its status, code and details", async () => {
    const { app } = setup();
    app.get("/api/v1/test/api-error", () => {
      throw new ApiError(409, "conflict", "Already exists", { id: "x" });
    });
    const res = await app.request("/api/v1/test/api-error");
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "conflict", message: "Already exists", details: { id: "x" } },
    });
  });

  it("replaces an HTTPException's text with ours and keeps WWW-Authenticate", async () => {
    const { app } = setup();
    app.get("/api/v1/test/unauthorized", () => {
      const res = new Response("library text", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="admin"', "X-Library": "1" },
      });
      throw new HTTPException(401, { res });
    });
    app.get("/api/v1/test/too-large", () => {
      throw new HTTPException(413, { message: "library text" });
    });

    const unauthorized = await app.request("/api/v1/test/unauthorized");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toBe('Bearer realm="admin"');
    expect(unauthorized.headers.get("X-Library")).toBeNull();
    expect(await unauthorized.json()).toEqual({
      error: { code: "unauthorized", message: "Unauthorized" },
    });

    const tooLarge = await app.request("/api/v1/test/too-large");
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: { code: "payload_too_large", message: "Payload too large" },
    });
  });

  it("answers a zod validation failure with 400 bad_request and the issues", async () => {
    const { app } = setup();
    const route = createRoute({
      method: "get",
      path: "/api/v1/test/validated",
      request: { query: z.object({ n: z.string().regex(/^[0-9]+$/) }) },
      responses: { 204: { description: "Valid" } },
    });
    app.openapi(route, (c) => c.body(null, 204));
    const res = await app.request("/api/v1/test/validated?n=abc");
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { target: string; issues: unknown[] } };
    };
    expect(body.error).toMatchObject({
      code: "bad_request",
      message: "Request validation failed",
      details: { target: "query", issues: [{ path: ["n"], code: "invalid_format" }] },
    });
    expect((await app.request("/api/v1/test/validated?n=42")).status).toBe(204);
  });
});

describe("secure headers", () => {
  it.each([
    ["JSON", "/api/v1/missing"],
    ["text 404", "/crl/missing.crl"],
    ["UI", "/"],
    ["405", "/api/v1/health"],
  ])("are on %s responses, without HSTS even over https", async (kind, path) => {
    const { app } = setup();
    for (const origin of ["http://aia.example", "https://aia.example"]) {
      const method = kind === "405" ? "POST" : "GET";
      const res = await app.request(`${origin}${path}`, { method });
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    }
  });
});

describe("request log", () => {
  it("writes exactly one request line per request, with the final status", async () => {
    const { app, deps } = setup();
    app.get("/api/v1/test/boom", () => {
      throw new Error("boom");
    });
    const cases: [method: string, path: string, status: number][] = [
      ["GET", "/api/v1/health", 200],
      ["HEAD", "/api/v1/health", 200],
      ["POST", "/api/v1/health", 405],
      ["GET", "/api/v1/test/boom", 500],
      ["GET", "/api/v1/missing", 404],
      ["GET", "/crl/missing.crl", 404],
      ["GET", `/crls/${UUID}`, 200],
      ["PUT", "/", 404],
    ];
    for (const [method, path, status] of cases) {
      const before = deps.lines.length;
      const res = await app.request(path, { method });
      expect(res.status).toBe(status);
      const records = deps.lines.slice(before).map((line) => JSON.parse(line) as LogLine);
      const requests = requestLines(records);
      expect(requests, `${method} ${path}`).toHaveLength(1);
      const [line] = requests;
      expect(Object.keys(line!).sort()).toEqual(["level", "method", "ms", "msg", "path", "status"]);
      expect(line).toMatchObject({ level: "info", msg: "request", method, path, status });
      expect(typeof line!.ms).toBe("number");
      // Only the 500 adds a line of its own (unhandled_error).
      expect(records.length - requests.length).toBe(status === 500 ? 1 : 0);
    }
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

  it("has no client unless trustProxy is set", async () => {
    const { app, deps } = setup();
    await app.request("/api/v1/health", {
      headers: { "X-Forwarded-For": "203.0.113.7", "CF-Connecting-IP": "198.51.100.1" },
    });
    expect(logRecords(deps)[0]).not.toHaveProperty("client");
  });

  it("adds the first X-Forwarded-For entry as client when trustProxy is set", async () => {
    const { app, deps } = setup({ settings: { trustProxy: true } });
    await app.request("/api/v1/health", {
      headers: { "X-Forwarded-For": " 203.0.113.7 , 10.0.0.1" },
    });
    await app.request("/api/v1/health", {
      headers: { "X-Forwarded-For": "203.0.113.7", "CF-Connecting-IP": "198.51.100.1" },
    });
    await app.request("/api/v1/health");
    const records = logRecords(deps);
    expect(records[0]).toMatchObject({ client: "203.0.113.7" });
    expect(records[1]).toMatchObject({ client: "198.51.100.1" });
    expect(records[2]).not.toHaveProperty("client");
  });

  it("writes one line of text in the pretty format", async () => {
    const { app, deps } = setup({ settings: { logFormat: "pretty" } });
    await app.request("/api/v1/health?token=s3cret");
    expect(deps.lines).toHaveLength(1);
    const [line] = deps.lines;
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line!) as unknown).toThrow(SyntaxError);
    expect(line).toMatch(/^INFO request method=GET path=\/api\/v1\/health status=200 ms=[0-9.]+$/);
  });
});
