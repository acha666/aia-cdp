// Health check (plan §7.1, §10 #15). Rewrite of the health part of
// worker-aia-cdp@5b570aa:src/worker/api/v2/stats.ts, which only listed the bucket and reported a
// hard-coded `cache: ok`. Here the store, config.json and catalog.json are really read.
//
// The configuration is what readState returns: the config rules are checked when a config is
// applied, so a stored config is only invalid when it is not JSON or fails its schema.
import { InvalidStoredObjectError, readState } from "./catalog.ts";
import type { ObjectStore } from "./store.ts";

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

/**
 * readState: a store error → unhealthy; config.json or catalog.json present but invalid →
 * invalid; config.json missing → missing; otherwise ok. Healthy only when both checks are ok; a
 * missing or invalid configuration is `degraded`. Store errors go to `onStoreError` (for the log),
 * never into the report.
 */
export async function checkHealth(
  store: ObjectStore,
  onStoreError: (error: unknown) => void = () => undefined
): Promise<HealthReport> {
  let configuration: ConfigurationCheck;
  try {
    const { config } = await readState(store);
    configuration = config === null ? "missing" : "ok";
  } catch (error) {
    if (!(error instanceof InvalidStoredObjectError)) {
      onStoreError(error);
      return UNHEALTHY;
    }
    configuration = "invalid";
  }
  return {
    status: configuration === "ok" ? "healthy" : "degraded",
    checks: { store: "ok", configuration },
  };
}
