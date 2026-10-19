import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { checkHealth } from "../../core/health.ts";
import { NO_STORE } from "../errors.ts";
import { createLogger, describeError } from "../log.ts";
import { HealthOk, HealthUnavailable } from "../schemas.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  summary: "Service health",
  description:
    "Reads the object store and config.json. `degraded` (still 200) while the service is not " +
    "configured yet or its configuration is invalid; 503 when the store cannot be read.",
  responses: {
    200: {
      description: "The store answers: healthy, or degraded (configuration missing or invalid)",
      content: { "application/json": { schema: HealthOk } },
    },
    503: {
      description: "The store failed; the configuration could not be checked",
      content: { "application/json": { schema: HealthUnavailable } },
    },
  },
});

export function healthRoutes(deps: AppDeps) {
  const log = createLogger(deps);
  return new OpenAPIHono<AppEnv>().openapi(healthRoute, async (c) => {
    const report = await checkHealth(deps.store, (error) => {
      log({ level: "error", msg: "health_store_error", error: describeError(error) });
    });
    if (report.status === "unhealthy") {
      return c.json(report, 503, NO_STORE);
    }
    return c.json(report, 200, NO_STORE);
  });
}
