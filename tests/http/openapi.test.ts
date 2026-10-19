// GET /api/v1/openapi.json (B11): generated from the route registry at run time, cached per app
// instance, and identical to the committed docs/openapi.json (scripts/generate-openapi.ts). The
// operationId / summary check replaces the old redocly lint.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testDeps } from "../helpers/app.ts";

interface Operation {
  operationId?: unknown;
  summary?: unknown;
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const committed = JSON.parse(
  readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8")
) as OpenApiDocument;

async function served(): Promise<{ res: Response; text: string; doc: OpenApiDocument }> {
  const res = await createApp(testDeps()).request("/api/v1/openapi.json");
  const text = await res.text();
  return { res, text, doc: JSON.parse(text) as OpenApiDocument };
}

function operations(doc: OpenApiDocument): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]): [string, Operation] => [
        `${method.toUpperCase()} ${path}`,
        operation,
      ])
  );
}

describe("GET /api/v1/openapi.json", () => {
  it("is served as public, max-age=300 JSON, byte for byte the same on every request", async () => {
    const app = createApp(testDeps());
    const first = await app.request("/api/v1/openapi.json");
    const second = await app.request("/api/v1/openapi.json");
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("is an OpenAPI 3.1 document with GET /api/v1/health and its 200 / 503 schemas", async () => {
    const { doc } = await served();
    expect(doc.openapi).toBe("3.1.0");
    const health = doc.paths["/api/v1/health"]?.get;
    expect(Object.keys(health?.responses ?? {}).sort()).toEqual(["200", "503"]);
    expect(health?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/HealthOk",
    });
    expect(health?.responses?.["503"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/HealthUnavailable",
    });
  });

  it("gives every operation a unique operationId and a summary", async () => {
    const { doc } = await served();
    const all = operations(doc);
    expect(all.map(([name]) => name)).toContain("GET /api/v1/health");
    for (const [name, operation] of all) {
      expect(operation.operationId, name).toEqual(expect.stringMatching(/^[a-z][A-Za-z0-9]*$/));
      expect(operation.summary, name).toEqual(expect.stringMatching(/\S/));
    }
    const ids = all.map(([, operation]) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deep-equals the committed docs/openapi.json", async () => {
    const { doc } = await served();
    expect(doc).toEqual(committed);
  });
});
