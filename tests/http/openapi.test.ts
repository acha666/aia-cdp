// GET /api/v1/openapi.json (B11): generated from the route registry at run time, cached per app
// instance, and identical to the committed docs/openapi.json (scripts/generate-openapi.ts). The
// rules of worker-aia-cdp@5b570aa:redocly.yaml are assertions here (slice 5a step 9): a unique
// operationId, a summary and declared tags on every operation, security on every admin
// operation, no unused component, and the size budget of slice 5a exit condition 9.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testDeps } from "../helpers/app.ts";

interface Operation {
  operationId?: unknown;
  summary?: unknown;
  tags?: unknown;
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; schema?: Record<string, unknown> }[];
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

interface OpenApiDocument {
  openapi: string;
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Record<string, unknown>>;
}

/** Slice 5a exit condition 9 (default): bytes of the document as served. */
const SIZE_BUDGET = 100_000;

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

  it("tags every operation with tags the document declares", async () => {
    const { doc } = await served();
    const declared = (doc.tags ?? []).map((tag) => tag.name);
    expect(new Set(declared).size).toBe(declared.length);
    const used = new Set<string>();
    for (const [name, operation] of operations(doc)) {
      expect(operation.tags, name).toEqual([expect.any(String)]);
      for (const tag of operation.tags as string[]) {
        expect(declared, name).toContain(tag);
        used.add(tag);
      }
    }
    expect([...used].sort()).toEqual([...declared].sort());
  });

  it("declares security on every admin operation, with a defined scheme", async () => {
    const { doc } = await served();
    const schemes = Object.keys(doc.components.securitySchemes ?? {});
    const admin = operations(doc).filter(([name]) => name.includes(" /api/v1/admin/"));
    expect(admin.length).toBeGreaterThan(0);
    for (const [name, operation] of admin) {
      expect(operation.security, name).toEqual([{ adminBearer: [] }]);
    }
    for (const [name, operation] of operations(doc)) {
      for (const requirement of operation.security ?? []) {
        for (const scheme of Object.keys(requirement)) {
          expect(schemes, name).toContain(scheme);
        }
      }
    }
  });

  it("references every component and resolves every $ref", async () => {
    const { doc } = await served();
    const refs = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") {
            refs.add(value);
          } else {
            visit(value);
          }
        }
      }
    };
    visit(doc.paths);
    visit(doc.components);
    for (const ref of refs) {
      const [, , kind = "", name = ""] = ref.split("/");
      expect(Object.hasOwn(doc.components[kind] ?? {}, name), ref).toBe(true);
    }
    for (const [kind, entries] of Object.entries(doc.components)) {
      if (kind === "securitySchemes") {
        continue;
      }
      for (const name of Object.keys(entries)) {
        expect(refs, `unused #/components/${kind}/${name}`).toContain(
          `#/components/${kind}/${name}`
        );
      }
    }
    // Security schemes are referenced by name from the operations' requirements.
    const required = new Set(
      operations(doc).flatMap(([, operation]) =>
        (operation.security ?? []).flatMap((requirement) => Object.keys(requirement))
      )
    );
    expect([...required].sort()).toEqual(Object.keys(doc.components.securitySchemes ?? {}).sort());
  });

  it(`stays within ${SIZE_BUDGET} bytes as served`, async () => {
    const { text } = await served();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(SIZE_BUDGET);
  });

  it.each([
    ["/api/v1/certificates", "listCertificates", ["200", "500"]],
    ["/api/v1/certificates/{id}", "getCertificate", ["200", "400", "404", "500"]],
    ["/api/v1/crls", "listCrlTargets", ["200", "500"]],
    ["/api/v1/crls/{targetId}", "getCrlTarget", ["200", "400", "404", "500"]],
    ["/api/v1/stats", "getStats", ["200", "500"]],
  ])(
    "documents GET %s as %s with exactly the statuses it can answer",
    async (path, id, statuses) => {
      const { doc } = await served();
      const operation = doc.paths[path]?.get;
      expect(operation?.operationId).toBe(id);
      expect(operation?.security).toBeUndefined();
      expect(Object.keys(operation?.responses ?? {})).toEqual(statuses);
      const schemaOf = (status: string) =>
        operation?.responses?.[status]?.content?.["application/json"]?.schema;
      expect(schemaOf("500")).toEqual({ $ref: "#/components/schemas/InternalError" });
      if (statuses.includes("404")) {
        expect(schemaOf("400")).toEqual({ $ref: "#/components/schemas/BadRequestError" });
        expect(schemaOf("404")).toEqual({ $ref: "#/components/schemas/NotFoundError" });
      }
    }
  );

  // Slice 5a step 6: both detail routes accept their id in either case and lowercase it, so the
  // documented parameter must accept either case too, or a client validating against the
  // document refuses a request the server serves.
  it("documents the detail ids as the routes accept them, in either case", async () => {
    const { doc } = await served();
    const parameter = (path: string) => doc.paths[path]?.get?.parameters?.[0];
    const id = parameter("/api/v1/certificates/{id}");
    expect(id).toMatchObject({ name: "id", in: "path", schema: { type: "string" } });
    const pattern = new RegExp(String(id?.schema?.pattern));
    for (const accepted of [
      "0a".repeat(32),
      "0A".repeat(32),
      `${"0a".repeat(16)}${"0A".repeat(16)}`,
    ]) {
      expect(accepted).toMatch(pattern);
    }
    for (const rejected of ["0a".repeat(31), "0g".repeat(32), "0a".repeat(33)]) {
      expect(rejected).not.toMatch(pattern);
    }
    // RFC 9562 §4: UUIDs are case-insensitive on input; format uuid says no more.
    expect(parameter("/api/v1/crls/{targetId}")).toMatchObject({
      name: "targetId",
      in: "path",
      schema: { type: "string", format: "uuid" },
    });
    expect(parameter("/api/v1/crls/{targetId}")?.schema).not.toHaveProperty("pattern");
  });

  it("names the extension variants, so that the extensionType discriminator has a mapping", async () => {
    const { doc } = await served();
    const extension = doc.components.schemas?.Extension as {
      properties: {
        parsed: { oneOf: unknown[]; discriminator: { propertyName: string; mapping: object } };
      };
    };
    const { oneOf, discriminator } = extension.properties.parsed;
    expect(oneOf).toHaveLength(41);
    expect(discriminator.propertyName).toBe("extensionType");
    expect(Object.keys(discriminator.mapping)).toHaveLength(41);
  });

  it("deep-equals the committed docs/openapi.json", async () => {
    const { doc } = await served();
    expect(doc).toEqual(committed);
  });
});
