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
  it("accepts a wrangler var written as a JSON number", async () => {
    const res = await get({ AIA_MAX_UPLOAD_BYTES: 1048576 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "degraded" });
    expect(records()).toEqual([expect.objectContaining({ msg: "request", status: 200 })]);
  });

  it.each<[string, unknown, string]>([
    ["AIA_MAX_UPLOAD_BYTES", { bytes: 1048576 }, "must be a positive integer (bytes)"],
    [
      "AIA_ADMIN_TOKEN",
      { secret: "s3cret" },
      "must be a bearer token: letters, digits and - . _ ~ + /, optionally ending in =",
    ],
  ])("answers 500 and logs the variable when %s is %j", async (name, value, message) => {
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
        error: `Invalid settings:\n  ${name}: ${message}`,
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
