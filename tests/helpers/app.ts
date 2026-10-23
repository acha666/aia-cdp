// Shared deps for HTTP tests: createApp(testDeps()).request(...) — no sockets.
import type { ObjectStore } from "../../src/core/store.ts";
import { INLINE_SCRIPT_HASHES } from "../../src/http/csp.ts";
import type { AppDeps, AppSettings } from "../../src/http/types.ts";
import { parseSettings } from "../../src/runtime/settings.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { NOW } from "../fixtures/pki.ts";

/** The smallest configuration that is `ok` now and under slice 2's full schema. */
export const MINIMAL_CONFIG = '{"version":1,"certificates":{},"targets":{},"paths":{}}';

/**
 * The Content-Security-Policy header of every response: implementation slice 5b step 10, with the
 * pre-paint script's hash from csp.ts (tests/http/csp.test.ts checks that against index.html).
 */
export const CSP_HEADER = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(" ")}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
].join("; ");

/** parseSettings({}): the same defaults as scripts/generate-openapi.ts. */
export function defaultSettings(): AppSettings {
  const parsed = parseSettings({});
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value.app;
}

export interface TestDeps extends AppDeps {
  /** Every line the app logged, in order. */
  lines: string[];
}

export interface TestOverrides extends Partial<Omit<AppDeps, "settings">> {
  settings?: Partial<AppSettings>;
}

/** MemoryStore, the fixtures' clock (manifest.now), default settings and a collecting log. */
export function testDeps(overrides: TestOverrides = {}): TestDeps {
  const lines: string[] = [];
  return {
    store: new MemoryStore(),
    now: () => new Date(NOW),
    log: (line) => {
      lines.push(line);
    },
    ...overrides,
    settings: { ...defaultSettings(), ...overrides.settings },
    lines,
  };
}

export interface LogLine {
  level: string;
  msg: string;
  [field: string]: unknown;
}

/** The JSON log lines (throws on a line that is not JSON). */
export function logRecords(deps: Pick<TestDeps, "lines">): LogLine[] {
  return deps.lines.map((line) => JSON.parse(line) as LogLine);
}

/** A store that delegates to `base` except for the overridden methods. */
export function patchStore(patch: Partial<ObjectStore>, base: ObjectStore = new MemoryStore()) {
  return {
    get: patch.get ?? ((key) => base.get(key)),
    put: patch.put ?? ((key, bytes, opts) => base.put(key, bytes, opts)),
    list: patch.list ?? ((prefix) => base.list(prefix)),
    delete: patch.delete ?? ((key) => base.delete(key)),
  } satisfies ObjectStore;
}

export async function putText(store: ObjectStore, key: string, text: string): Promise<void> {
  const result = await store.put(key, new TextEncoder().encode(text));
  if (!result.ok) {
    throw new Error(`put ${key}: ${result.reason}`);
  }
}
