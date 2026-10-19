import { hc } from "hono/client";
import type { AppType } from "../../http/app.ts";

// Typed same-origin client for the server's routes (type-only import: no server code is bundled,
// only hono/client). `cache: "no-store"` keeps the browser's HTTP cache out of every API call; the
// API also answers with `Cache-Control: no-store`.
export const api = hc<AppType>("", { init: { cache: "no-store" } });
