import { hc } from "hono/client";
import type { AppType } from "../../http/app.ts";
import { apiFetch } from "./errors";

// Typed same-origin client for the server's public routes (type-only import: no server code is
// bundled, only hono/client). `cache: "no-store"` keeps the browser's HTTP cache out of every API
// call; the API also answers with `Cache-Control: no-store`. apiFetch makes a request that gets no
// response reject with ApiError `network`; a response is read with unwrap (errors.ts):
// `unwrap(await api.api.v1.crls.$get())`.
export const api = hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch });
