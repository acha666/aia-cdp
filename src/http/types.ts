import type { ObjectStore } from "../core/store.ts";

/** Runtime-independent settings (plan §4.2); parsed from the environment by src/runtime/settings.ts. */
export interface AppSettings {
  maxUploadBytes: number;
  /** Unset: every admin route answers 503 admin_disabled. */
  adminToken?: string;
  /** Unset: uploads need no token. */
  uploadToken?: string;
}

/** Everything the app needs from its runtime (plan §4.4). The app never sees a runtime env. */
export interface AppDeps {
  store: ObjectStore;
  now: () => Date;
  /** Backoff between conditional catalog writes; a real timer when omitted (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  settings: AppSettings;
  /** Receives one finished log line per call. Node: stdout; Workers: console.log. */
  log: (line: string) => void;
  /**
   * UI fallback for GET / HEAD on paths outside the reserved prefixes. Workers: env.ASSETS.fetch;
   * Node: serveStatic + index.html (src/runtime/node-ui.ts). The app copies the response before
   * changing headers, so an immutable binding response is fine.
   */
  ui?: (req: Request) => Response | Promise<Response>;
}
