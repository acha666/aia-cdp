// Shared by the read route tests of slice 5a (tests/http/{certificates,crl-targets,lists,stats}
// .test.ts): a service set up as an operator would (importCertificate, applyConfig, publishCrl on a
// MemoryStore), a store that records its reads, and the envelope / header checks every response
// of a read route must pass.
import { expect } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { patchStore, testDeps } from "./app.ts";
import type { TestDeps, TestOverrides } from "./app.ts";
import { publishFile, setupPublish } from "./publish.ts";
import type { PublishSetup, SetupOptions } from "./publish.ts";

export interface ReadServiceOptions {
  /** The shared setup of tests/helpers/publish.ts unless given. */
  setup?: SetupOptions;
  /** CRL fixtures published in order; each must be created or updated. */
  publish?: readonly string[];
  /** Wraps the store the setup wrote, for the app only. */
  wrap?: (base: ObjectStore) => ObjectStore;
  overrides?: TestOverrides;
}

export interface ReadService {
  app: ReturnType<typeof createApp>;
  deps: TestDeps;
  /** The store the setup wrote (unwrapped). */
  base: MemoryStore;
  setup: PublishSetup;
}

export async function readService(options: ReadServiceOptions = {}): Promise<ReadService> {
  const base = new MemoryStore();
  const setup = await setupPublish(base, options.setup);
  for (const file of options.publish ?? []) {
    const { result } = await publishFile(base, file);
    if (!("outcome" in result) || result.outcome === "unchanged") {
      throw new Error(`publish ${file}: ${JSON.stringify(result)}`);
    }
  }
  const store = options.wrap?.(base) ?? base;
  const deps = testDeps({ ...options.overrides, store });
  return { app: createApp(deps), deps, base, setup };
}

/** config.json and catalog.json as the routes read them. */
export function stateOf(service: Pick<ReadService, "base">) {
  return readState(service.base);
}

export interface RecordingReads extends ObjectStore {
  /** The key of every get, in call order. */
  gets: string[];
  /** The prefix of every list call. */
  lists: string[];
}

/** `base`, recording every get and list (both still answer). */
export function recordReads(base: ObjectStore): RecordingReads {
  const gets: string[] = [];
  const lists: string[] = [];
  return {
    ...patchStore(
      {
        get: (key) => {
          gets.push(key);
          return base.get(key);
        },
        list: (prefix) => {
          lists.push(prefix);
          return base.list(prefix);
        },
      },
      base
    ),
    gets,
    lists,
  };
}

/** The JSON body of a 200 read: application/json and no-store (§10 #17). */
export async function okJson(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return res.json();
}

/**
 * The envelope of a failed read with `status` and `code`, exactly `{ error: { code, message,
 * details? } }`, no-store. Returns the error object.
 */
export async function errorOf(
  res: Response,
  status: number,
  code: string
): Promise<{ code: string; message: string; details?: unknown }> {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error).sort()).toEqual(
    "details" in body.error ? ["code", "details", "message"] : ["code", "message"]
  );
  expect(body.error.code).toBe(code);
  return body.error;
}

/** The plain 500: the fixed text only, never the exception or a store key. */
export async function expectInternal(res: Response, ...secrets: string[]): Promise<void> {
  const text = await res.clone().text();
  expect(await errorOf(res, 500, "internal")).toEqual({
    code: "internal",
    message: "Internal server error",
  });
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

/** HEAD of a read: 200, no-store, no body (Hono's automatic HEAD of the GET). */
export async function expectHead(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(0);
}
