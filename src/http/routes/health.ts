import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { checkHealth, Health } from "../../core/health.ts";
import { NO_STORE } from "../errors.ts";
import { describeError } from "../log.ts";
import { jsonResponse } from "../schemas.ts";
import type { AppDeps } from "../types.ts";

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  summary: "Service health",
  tags: ["health"],
  description:
    "Reads the object store and config.json. `degraded` (still 200) while the service is not " +
    "configured yet or its configuration is invalid; 503 when the store cannot be read.",
  responses: {
    200: jsonResponse(
      "The store answers: healthy, or degraded (configuration missing or invalid)",
      Health
    ),
    503: jsonResponse("The store failed; the configuration could not be checked", Health),
  },
});

export function healthRoutes(deps: AppDeps) {
  return new OpenAPIHono().openapi(healthRoute, async (c) => {
    const report = await checkHealth(deps.store, (error) => {
      deps.log({ level: "error", msg: "health_store_error", error: describeError(error) });
    });
    if (report.status === "unhealthy") {
      return c.json(report, 503, NO_STORE);
    }
    return c.json(report, 200, NO_STORE);
  });
}
