// Health check (plan §7.1, §10 #15). Rewrite of the health part of
// worker-aia-cdp@5b570aa:src/worker/api/v2/stats.ts, which only listed the bucket and reported a
// hard-coded `cache: ok`. Here the store and config.json are really read.
//
// Slice 1 only checks that config.json is JSON with `version === 1`; slice 2 replaces
// isValidConfig with the full config schema and rules.
import type { ObjectStore } from "./store.ts";

export const CONFIG_KEY = "config.json";

export type ConfigurationCheck = "ok" | "missing" | "invalid";

export type HealthReport =
  | {
      status: "healthy" | "degraded";
      checks: { store: "ok"; configuration: ConfigurationCheck };
    }
  | {
      status: "unhealthy";
      checks: { store: "error"; configuration: "unknown" };
    };

const UNHEALTHY: HealthReport = {
  status: "unhealthy",
  checks: { store: "error", configuration: "unknown" },
};

function isValidConfig(bytes: Uint8Array): boolean {
  let value: unknown;
  try {
    // Both options spelled out: the Workers types declare them as required.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "version" in value &&
    value.version === 1
  );
}

/**
 * `head("config.json")` throws → unhealthy; null → missing; present → `get` and validate
 * (a throwing `get` is unhealthy too). Healthy only when both checks are ok; a missing or invalid
 * configuration is `degraded`. Store errors go to `onStoreError` (for the log), never into the
 * report.
 */
export async function checkHealth(
  store: ObjectStore,
  onStoreError: (error: unknown) => void = () => undefined
): Promise<HealthReport> {
  let configuration: ConfigurationCheck;
  try {
    if ((await store.head(CONFIG_KEY)) === null) {
      configuration = "missing";
    } else {
      // Deleted between head and get: as good as missing.
      const object = await store.get(CONFIG_KEY);
      configuration = object === null ? "missing" : isValidConfig(object.bytes) ? "ok" : "invalid";
    }
  } catch (error) {
    onStoreError(error);
    return UNHEALTHY;
  }
  return {
    status: configuration === "ok" ? "healthy" : "degraded",
    checks: { store: "ok", configuration },
  };
}
