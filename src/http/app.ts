// The one HTTP application behind both runtimes (plan §4.4, §7.3). It knows nothing about a
// runtime env: the store, clock, settings, log sink and UI fallback come in as AppDeps.
//
// Rules: every route is registered here, before the first request (SmartRouter freezes then);
// never `app.get("*")` (methodNotAllowed would turn every unknown-path POST into 405) — the UI
// fallback lives in notFound.
import { OpenAPIHono } from "@hono/zod-openapi";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { createErrorHandler, onMethodNotAllowed, validationHook } from "./errors.ts";
import { createLogger, requestLog } from "./log.ts";
import { healthRoutes } from "./routes/health.ts";
import type { AppDeps, AppEnv } from "./types.ts";
import { uiFallback } from "./ui.ts";

export type { AppDeps, AppEnv, AppSettings, ClientIpHeader } from "./types.ts";

/** Shared by GET /api/v1/openapi.json and scripts/generate-openapi.ts (docs/openapi.json). */
export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "aia-cdp API", version: "1" },
};

export function createApp(deps: AppDeps) {
  const log = createLogger(deps);
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.onError(createErrorHandler(log));
  app.notFound(uiFallback(deps));

  // Order (plan §7.3): secureHeaders → request log → methodNotAllowed → (auth / bodyLimit,
  // slices 2 and 4) → routes.
  app.use(secureHeaders({ strictTransportSecurity: false }));
  app.use(requestLog(deps, log));
  app.use(methodNotAllowed({ app, onMethodNotAllowed }));

  // Generated from the route registry on the first request and kept for the life of this app
  // (one per process / isolate). Not part of the document itself.
  let openapiJson: string | undefined;
  app.get("/api/v1/openapi.json", (c) => {
    openapiJson ??= JSON.stringify(app.getOpenAPI31Document(OPENAPI_CONFIG));
    return c.body(openapiJson, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "public, max-age=300",
    });
  });

  // The chained value carries the route types: AppType (hc<AppType>) is inferred from it.
  return app.route("/api/v1", healthRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
export type AppType = App;
