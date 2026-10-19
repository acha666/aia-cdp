// Health check (plan §7.1, §10 #15). Rewrite of the health part of
// worker-aia-cdp@5b570aa:src/worker/api/v2/stats.ts, which only listed the bucket and reported a
// hard-coded `cache: ok`. Here the store, config.json and catalog.json are really read.
//
// The configuration is checked with the static and state rules of src/core/admin.ts (V1–V6)
// against catalog.json. The migration rules (V7–V9) compare a new config with the current one and
// only apply when a config is applied.
import { checkConfigState, checkConfigStatic } from "./admin.ts";
import { CATALOG_KEY, CatalogSchema, CONFIG_KEY, decodeJson, emptyCatalog } from "./catalog.ts";
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

// config.json is present. Invalid: either object is not UTF-8 JSON or fails its schema, or the
// config breaks a static or state rule. A missing catalog.json is the empty catalog.
function checkConfiguration(config: Uint8Array, catalog: Uint8Array | null): ConfigurationCheck {
  let configValue: unknown;
  let catalogValue: unknown;
  try {
    configValue = decodeJson(config);
    catalogValue = catalog === null ? emptyCatalog() : decodeJson(catalog);
  } catch {
    return "invalid";
  }
  const checked = checkConfigStatic(configValue);
  const parsedCatalog = CatalogSchema.safeParse(catalogValue);
  if (!checked.ok || !parsedCatalog.success) {
    return "invalid";
  }
  return checkConfigState(checked.config, parsedCatalog.data).length === 0 ? "ok" : "invalid";
}

/**
 * `get` of config.json and catalog.json; either throwing → unhealthy. config.json missing →
 * missing; otherwise ok or invalid (checkConfiguration). Healthy only when both checks are ok; a
 * missing or invalid configuration is `degraded`. Store errors go to `onStoreError` (for the log),
 * never into the report.
 */
export async function checkHealth(
  store: ObjectStore,
  onStoreError: (error: unknown) => void = () => undefined
): Promise<HealthReport> {
  let objects: [{ bytes: Uint8Array } | null, { bytes: Uint8Array } | null];
  try {
    objects = await Promise.all([store.get(CONFIG_KEY), store.get(CATALOG_KEY)]);
  } catch (error) {
    onStoreError(error);
    return UNHEALTHY;
  }
  const [config, catalog] = objects;
  const configuration =
    config === null ? "missing" : checkConfiguration(config.bytes, catalog?.bytes ?? null);
  return {
    status: configuration === "ok" ? "healthy" : "degraded",
    checks: { store: "ok", configuration },
  };
}
