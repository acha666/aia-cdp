// Health check (plan §7.1): config.json and catalog.json are read from the store, so a store that
// cannot serve them or an invalid stored object shows in the report.
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
  onStoreError: (error: unknown) => void
): Promise<HealthReport> {
  let configuration: ConfigurationCheck;
  try {
    const { hasConfig } = await readState(store);
    configuration = hasConfig ? "ok" : "missing";
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
