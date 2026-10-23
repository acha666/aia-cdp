// GET /api/v1/stats (plan §7.1): counts and bytes by resource from config.json and catalog.json
// alone, never a store listing. No time-dependent field: the UI computes what is expiring or stale
// with its own clock. A public sub-app in the AppType chain.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { readState } from "../../core/catalog.ts";
import { stats } from "../../core/views.ts";
import { NO_STORE } from "../errors.ts";
import { InternalError, Stats } from "../schemas.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const getStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  operationId: "getStats",
  summary: "Service statistics",
  description:
    "Imported certificates, configured targets and published CRLs by kind, the revoked entries " +
    "of the published full CRLs and the DER bytes of the certificates and current CRLs.",
  tags: ["stats"],
  responses: {
    200: { description: "The statistics", content: { "application/json": { schema: Stats } } },
    500: {
      description: "The store failed (logged, never sent); retry later",
      content: { "application/json": { schema: InternalError } },
    },
  },
});

export function statsRoutes(deps: AppDeps) {
  return new OpenAPIHono<AppEnv>().openapi(getStatsRoute, async (c) => {
    const { config, catalog } = await readState(deps.store);
    return c.json(stats(config, catalog), 200, NO_STORE);
  });
}
