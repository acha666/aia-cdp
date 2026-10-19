// Node 24 entry (plan §4.2): FsStore on AIA_DATA_DIR, the built UI from AIA_STATIC_DIR.
// Production: node --enable-source-maps dist/server/runtime/node.js; development and tests run the
// source directly: node src/runtime/node.ts (type stripping).
import { constants, accessSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";
import { serve } from "@hono/node-server";
import { createApp } from "../http/app.ts";
import { describeError, formatLogLine } from "../http/log.ts";
import type { LogRecord } from "../http/log.ts";
import { FsStore } from "../storage/fs.ts";
import { createNodeUi } from "./node-ui.ts";
import { parseSettings, resolveFileVariants } from "./settings.ts";

/**
 * After SIGTERM / SIGINT: requests already running get this long, then every connection still
 * open is closed, including sockets that never sent a complete request (a preconnect, a load
 * balancer's TCP probe, a slow client), which server.close() alone waits for forever. Well
 * inside `docker stop`'s 10 s.
 */
const GRACE_MS = 2_000;
/** Last resort if closing still has not finished. */
const FORCED_EXIT_MS = 10_000;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Settings errors go to stderr as text: the log format is not known yet.
  const resolved = resolveFileVariants(process.env, (path) => readFileSync(path, "utf8"));
  const parsed = resolved.ok ? parseSettings(resolved.value) : resolved;
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  const settings = parsed.value;
  const write = (line: string) => {
    process.stdout.write(`${line}\n`);
  };
  const log = (record: LogRecord) => {
    write(formatLogLine(settings.app.logFormat, record));
  };

  try {
    if (!statSync(settings.dataDir).isDirectory()) {
      throw new Error(`${settings.dataDir} is not a directory`);
    }
    accessSync(settings.dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    log({
      level: "error",
      msg: "data_dir_unusable",
      dataDir: settings.dataDir,
      error: describeError(error),
    });
    process.exitCode = 1;
    return;
  }

  // Not fatal: `pnpm run dev:node` runs without a UI build (the Vite dev server serves the UI).
  // Without it every UI path answers the text 404 while health stays green, so say so once.
  const staticDir = resolve(settings.staticDir);
  if (!isFile(join(staticDir, "index.html"))) {
    log({ level: "warn", msg: "static_dir_missing", staticDir });
  }

  const store = new FsStore(settings.dataDir);
  // Before serving, so no put is running (one process per directory, plan §1).
  try {
    const count = await store.removeTemporaryFiles();
    log({ level: "info", msg: "temp_files_removed", count });
  } catch (error) {
    log({ level: "warn", msg: "temp_files_cleanup_failed", error: describeError(error) });
  }

  const app = createApp({
    store,
    now: () => new Date(),
    settings: settings.app,
    // Behind nginx / Traefik: the right-most entry is the one the nearest proxy appended.
    clientIpHeader: "x-forwarded-for",
    log: write,
    ui: createNodeUi(staticDir),
  });

  // Explicit port (@hono/node-server defaults to 3000); no hostname, so Node listens on `::`
  // (dual stack). PORT=0 picks a free port: the listening line reports the real one. Without a
  // createServer option serve() returns a node:http Server.
  const server = serve({ fetch: app.fetch, port: settings.port }, (info) => {
    log({ level: "info", msg: "listening", port: info.port });
  }) as Server;
  // EADDRINUSE and friends would otherwise crash with an unhandled 'error' event.
  server.on("error", (error) => {
    log({ level: "error", msg: "server_error", error: describeError(error) });
    process.exit(1);
  });

  // node is PID 1 in the container: without these handlers SIGTERM would not stop it.
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log({ level: "info", msg: "shutdown", signal });
    // Stops accepting and calls back once every connection has closed.
    server.close((error) => {
      if (error) {
        log({ level: "error", msg: "closed", error: describeError(error) });
        process.exit(1);
      }
      log({ level: "info", msg: "closed" });
      process.exit(0);
    });
    // Idle keep-alive sockets now; in-flight requests get GRACE_MS, then everything left goes
    // (close() also stops Node's header timeout, so a socket without a request never would).
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
    }, GRACE_MS).unref();
    setTimeout(() => {
      log({ level: "error", msg: "forced_exit", afterMs: FORCED_EXIT_MS });
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

await main();
