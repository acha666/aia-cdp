// The one HTTP application behind both runtimes (plan §4.4, §7.3). It knows nothing about a
// runtime env: the store, clock, settings, log sink and UI fallback come in as AppDeps.
//
// Rules: every route is registered here, before the first request (SmartRouter freezes then);
// never `app.get("*")` (methodNotAllowed would turn every unknown-path POST into 405) — the UI
// fallback lives in notFound.
import { OpenAPIHono } from "@hono/zod-openapi";
import { methodNotAllowed } from "hono/method-not-allowed";
import { securityHeaders } from "./csp.ts";
import { createErrorHandler, validationHook } from "./errors.ts";
import { requestLog } from "./log.ts";
import { adminRoutes } from "./routes/admin.ts";
import { certificateRoutes } from "./routes/certificates.ts";
import { crlRoutes } from "./routes/crls.ts";
import { downloadRoutes } from "./routes/downloads.ts";
import { healthRoutes } from "./routes/health.ts";
import { statsRoutes } from "./routes/stats.ts";
import type { AppDeps } from "./types.ts";
import { onMethodNotAllowed, uiFallback } from "./ui.ts";

const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "aia-cdp API", version: "1" },
  // Every operation carries one of these (tests/http/openapi.test.ts).
  tags: [
    { name: "health", description: "Service health" },
    { name: "certificates", description: "Imported CA certificates" },
    { name: "crls", description: "CRL targets: their current CRLs, and the upload" },
    { name: "stats", description: "Counts and sizes" },
    { name: "admin", description: "Certificate import and config.json (AIA_ADMIN_TOKEN)" },
  ],
};

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.onError(createErrorHandler(deps.log));
  app.notFound(uiFallback(deps));

  // Order (plan §7.3): secureHeaders → request log → methodNotAllowed → (admin: token check,
  // bearerAuth, bodyLimit in routes/admin.ts; CRL upload: optional bearerAuth, media type gate,
  // bodyLimit as route middleware in routes/crls.ts) → routes.
  // secureHeaders covers every response, the UI's too (ui.ts copies the deps.ui answer first); its
  // CSP is the UI's (csp.ts) and changes nothing for JSON or downloads.
  app.use(securityHeaders);
  app.use(requestLog(deps.log));
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

  // The chained value carries the route types: AppType (hc<AppType>) is inferred from it. Only
  // the public routes (health, certificates, CRL targets with the upload, stats) join the chain;
  // the admin routes are served and documented, but stay out of the web client's types. The
  // download routes (/ca/*, /crl/*, /dcrl/*) are a plain Hono app: neither in AppType nor in the
  // OpenAPI document.
  const routes = app
    .route("/api/v1", healthRoutes(deps))
    .route("/api/v1", certificateRoutes(deps))
    .route("/api/v1", crlRoutes(deps))
    .route("/api/v1", statsRoutes(deps));
  app.route("/api/v1", adminRoutes(deps));
  app.route("/", downloadRoutes(deps));
  return routes;
}

export type AppType = ReturnType<typeof createApp>;
