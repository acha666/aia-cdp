// The Workers entry (src/runtime/worker.ts) in-process: a fake R2 bucket as STORE, an ASSETS
// stand-in, console.log captured. worker.ts belongs to the Worker program only (Env and
// ExportedHandler come from `wrangler types`), so it is loaded through a variable specifier that the
// Node program's type check does not follow; at run time it needs none of those globals.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeR2Bucket } from "../storage/fakes/r2-bucket.ts";

interface WorkerEntry {
  fetch(request: Request, env: object, ctx: object): Response | Promise<Response>;
}

/** What `headers` in a RequestInit takes (HeadersInit is not a global in the Node program). */
type HeaderFields = NonNullable<RequestInit["headers"]>;

const ENTRY = fileURLToPath(new URL("../../src/runtime/worker.ts", import.meta.url));
const worker = ((await import(ENTRY)) as { default: WorkerEntry }).default;

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };

/** A new env object per call: the entry caches one app per env. */
function env(vars: Record<string, unknown>): object {
  return {
    STORE: new FakeR2Bucket(),
    ASSETS: {
      fetch: () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
    },
    ...vars,
  };
}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function get(vars: Record<string, unknown>, headers: HeaderFields = {}): Promise<Response> {
  return worker.fetch(
    new Request("https://pki.example/api/v1/health", { headers }),
    env(vars),
    CTX
  );
}

describe("src/runtime/worker.ts", () => {
  it("accepts wrangler vars written as a JSON boolean and number", async () => {
    const res = await get(
      { AIA_TRUST_PROXY: true, AIA_MAX_UPLOAD_BYTES: 1048576 },
      { "CF-Connecting-IP": "198.51.100.1", "X-Forwarded-For": "203.0.113.7" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "degraded" });
    // trustProxy is on, and the Worker takes the client from CF-Connecting-IP only.
    expect(records()).toEqual([
      expect.objectContaining({ msg: "request", status: 200, client: "198.51.100.1" }),
    ]);
  });

  it("reads AIA_TRUST_PROXY: false (boolean) and the string forms the same way", async () => {
    const headers = { "CF-Connecting-IP": "198.51.100.1" };
    expect((await get({ AIA_TRUST_PROXY: false }, headers)).status).toBe(200);
    expect(
      (await get({ AIA_TRUST_PROXY: "true", AIA_MAX_UPLOAD_BYTES: "1048576" }, headers)).status
    ).toBe(200);
    expect(records().map((record) => record.client)).toEqual([undefined, "198.51.100.1"]);
  });

  it("does not take the client from X-Forwarded-For", async () => {
    await get({ AIA_TRUST_PROXY: "true" }, { "X-Forwarded-For": "203.0.113.7" });
    expect(records()).toEqual([expect.objectContaining({ msg: "request", status: 200 })]);
    expect(records()[0]).not.toHaveProperty("client");
  });

  it.each<[string, unknown]>([
    ["AIA_LOG_FORMAT", ["json"]],
    ["AIA_MAX_UPLOAD_BYTES", { bytes: 1048576 }],
    ["AIA_TRUST_PROXY", null],
    ["AIA_ADMIN_TOKEN", { secret: "s3cret" }],
  ])("answers 500 and logs the variable when %s is %j", async (name, value) => {
    const res = await get({ [name]: value });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "Internal server error" },
    });
    expect(records()).toEqual([
      {
        level: "error",
        msg: "invalid_settings",
        error: `Invalid settings:\n  ${name}: must be a string, number or boolean (a wrangler var cannot be an object, array or null)`,
      },
    ]);
    expect(lines.join("\n")).not.toContain("s3cret");
  });

  it("reports a number that is not a valid value through parseSettings", async () => {
    const res = await get({ AIA_MAX_UPLOAD_BYTES: 1.5 });
    expect(res.status).toBe(500);
    expect(records()).toEqual([
      expect.objectContaining({
        msg: "invalid_settings",
        error: "Invalid settings:\n  AIA_MAX_UPLOAD_BYTES: must be a positive integer (bytes)",
      }),
    ]);
  });
});
