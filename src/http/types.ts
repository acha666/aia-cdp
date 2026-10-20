import type { ObjectStore } from "../core/store.ts";

/** Runtime-independent settings (plan §4.2); parsed from the environment by src/runtime/settings.ts. */
export interface AppSettings {
  logFormat: "json" | "pretty";
  /** Adds `client` to request logs, from the header AppDeps.clientIpHeader names. */
  trustProxy: boolean;
  maxUploadBytes: number;
  /** Unset: every admin route answers 503 admin_disabled (slice 2). */
  adminToken?: string;
  /** Unset: uploads need no token (slice 4). */
  uploadToken?: string;
}

/**
 * Where the request log's `client` comes from when settings.trustProxy is set; each entry point
 * picks the one its runtime can trust. Workers: `cf-connecting-ip`, set by Cloudflare's edge. Node:
 * `x-forwarded-for`, its right-most entry only (the address the nearest proxy appended; entries
 * to the left are whatever the client sent). Either way only an IPv4 / IPv6 literal is logged.
 */
export type ClientIpHeader = "cf-connecting-ip" | "x-forwarded-for";

/** Everything the app needs from its runtime (plan §4.4). The app never sees a runtime env. */
export interface AppDeps {
  store: ObjectStore;
  now: () => Date;
  /** Backoff between conditional catalog writes; a real timer when omitted (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  settings: AppSettings;
  clientIpHeader: ClientIpHeader;
  /** Receives one finished log line per call. Node: stdout; Workers: console.log. */
  log: (line: string) => void;
  /**
   * UI fallback for GET / HEAD on paths outside the reserved prefixes. Workers: env.ASSETS.fetch;
   * Node: serveStatic + index.html (src/runtime/node-ui.ts). The app copies the response before
   * changing headers, so an immutable binding response is fine.
   */
  ui?: (req: Request) => Response | Promise<Response>;
}

// No Bindings on purpose: the app must not depend on a runtime's env shape.
export interface AppEnv {
  Variables: Record<string, never>;
}
