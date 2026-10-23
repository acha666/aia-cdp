// The Node entry as a real process on a real socket: `node src/runtime/node.ts` (type stripping),
// PORT=0, a temporary data directory and a temporary static directory standing in for dist/web
// (implementation slice 1 step 5). Only what needs a socket or a process lives here; the routing
// rules are covered in-process by tests/http.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSettings, resolveFileVariants } from "../../src/runtime/settings.ts";
import { MINIMAL_CONFIG } from "../helpers/app.ts";
import type { LogLine } from "../helpers/app.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = fileURLToPath(new URL("../../src/runtime/node.ts", import.meta.url));
const UUID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const INDEX_HTML = "<!doctype html><title>aia-cdp test UI</title>\n";
const SCRIPT = "export const ui = 1;\n";
const TIMEOUT = 20_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Server {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: () => string;
  stderr: () => string;
  /** Every stdout line, parsed (throws on a line that is not JSON). */
  records: () => LogLine[];
  /** The port from the `listening` line; rejects if the process ends first. */
  listening: Promise<number>;
  /** After the process ended and its output was read to the end. */
  closed: Promise<Exit>;
}

const running = new Set<Server>();
/** The server of the real-socket suite: it ends in that suite's last test, not in afterEach. */
let shared: Server | undefined;
let scratch: string;
let staticDir: string;

function stdoutLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

/** Starts the entry with exactly `env` (plus PATH): no AIA_* leaks in from the caller's shell. */
function start(env: Record<string, string>): Server {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<Exit>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const listening = new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      // Complete lines only: a chunk may end in the middle of one.
      for (const line of stdoutLines(stdout.slice(0, stdout.lastIndexOf("\n") + 1))) {
        if (line.includes('"msg":"listening"')) {
          resolve((JSON.parse(line) as { port: number }).port);
        }
      }
    });
    void closed.then(({ code }) => {
      reject(new Error(`exited with ${code} before listening\n${stdout}${stderr}`));
    });
  });
  // Not every test waits for it.
  listening.catch(() => undefined);
  const server: Server = {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    records: () => stdoutLines(stdout).map((line) => JSON.parse(line) as LogLine),
    listening,
    closed,
  };
  running.add(server);
  return server;
}

async function freshDataDir(): Promise<string> {
  return mkdtemp(join(scratch, "data-"));
}

/** A raw client socket; errors (the server resetting it at shutdown) are expected and ignored. */
async function openSocket(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  await once(socket, "connect");
  return socket;
}

/**
 * One request on a raw socket (`Connection: close`), so that bytes after the header block are
 * seen even for HEAD, where fetch() would drop them.
 */
async function rawRequest(
  port: number,
  method: string,
  path: string
): Promise<{ status: number; headers: Map<string, string>; body: Buffer }> {
  const socket = connect(port, "127.0.0.1");
  socket.setTimeout(5_000, () => socket.destroy(new Error("raw request timed out")));
  await once(socket, "connect");
  // Not socket.end(): a half-closed client makes Node's http server abort the request.
  socket.write(
    `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
  );
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    chunks.push(chunk as Buffer);
  }
  const all = Buffer.concat(chunks);
  const end = all.indexOf("\r\n\r\n");
  const [statusLine = "", ...fields] = all.subarray(0, end).toString("latin1").split("\r\n");
  const headers = new Map<string, string>();
  for (const field of fields) {
    const colon = field.indexOf(":");
    headers.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body: all.subarray(end + 4) };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-node-runtime-"));
  staticDir = join(scratch, "web");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), INDEX_HTML);
  await writeFile(join(staticDir, "assets", "index-abc.js"), SCRIPT);
});

afterEach(() => {
  // A failed test must not leave its process behind.
  for (const server of running) {
    if (server !== shared && server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
    }
  }
});

afterAll(async () => {
  for (const server of running) {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
    }
    await server.closed;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("node src/runtime/node.ts on a real socket", { timeout: TIMEOUT }, () => {
  let server: Server;
  let port: number;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await freshDataDir();
    server = start({
      PORT: "0",
      AIA_DATA_DIR: dataDir,
      AIA_STATIC_DIR: staticDir,
    });
    shared = server;
    port = await server.listening;
    base = `http://127.0.0.1:${port}`;
  }, TIMEOUT);

  it("listens on the free port that PORT=0 picked and logs it", () => {
    expect(port).toBeGreaterThan(0);
    expect(server.records()[0]).toEqual({ level: "info", msg: "listening", port });
  });

  it("reports degraded, then healthy once the minimal configuration is written", async () => {
    const before = await fetch(`${base}/api/v1/health`);
    expect(before.status).toBe(200);
    expect(before.headers.get("Cache-Control")).toBe("no-store");
    expect(await before.json()).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "missing" },
    });

    await writeFile(join(dataDir, "config.json"), MINIMAL_CONFIG);
    const after = await fetch(`${base}/api/v1/health`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it("answers HEAD /api/v1/health with 200 and no body", async () => {
    const res = await rawRequest(port, "HEAD", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.byteLength).toBe(0);
  });

  it("answers HEAD on a UI route with the index.html Content-Length and no body", async () => {
    const res = await rawRequest(port, "HEAD", `/crls/${UUID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.body.byteLength).toBe(0);
  });

  it("serves index.html for history routes and hashed assets as immutable", async () => {
    const page = await fetch(`${base}/crls/${UUID}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-cache");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await page.text()).toBe(INDEX_HTML);

    const script = await fetch(`${base}/assets/index-abc.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe(SCRIPT);
  });

  it("answers a download-prefix miss with the text/plain 404", async () => {
    const res = await fetch(`${base}/crl/x.crl`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
  });

  it("answers a missing hashed asset with 404, not index.html", async () => {
    const res = await fetch(`${base}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Not Found");
  });

  it("exits 0 on SIGTERM, logging shutdown and closed; every stdout line is JSON", async () => {
    server.child.kill("SIGTERM");
    expect(await server.closed).toEqual({ code: 0, signal: null });

    const lines = stdoutLines(server.stdout());
    for (const line of lines) {
      const record = JSON.parse(line) as Partial<LogLine>;
      expect(typeof record.level, line).toBe("string");
      expect(typeof record.msg, line).toBe("string");
    }
    const messages = server.records().map((record) => record.msg);
    expect(messages).toContain("request");
    expect(messages.slice(-2)).toEqual(["shutdown", "closed"]);
    expect(server.records().at(-2)).toMatchObject({ level: "info", signal: "SIGTERM" });
    expect(server.stderr()).toBe("");
  });
});

describe("node src/runtime/node.ts start-up failures", { timeout: TIMEOUT }, () => {
  it("exits 1 on PORT=abc and names PORT on stderr", async () => {
    const server = start({ PORT: "abc", AIA_DATA_DIR: await freshDataDir() });
    expect((await server.closed).code).toBe(1);
    expect(server.stderr()).toMatch(/^\s*PORT: /m);
    expect(server.stdout()).toBe("");
  });

  it("exits 1 with a JSON error log when the data directory does not exist", async () => {
    const missing = join(scratch, "no-such-dir");
    const server = start({ PORT: "0", AIA_DATA_DIR: missing, AIA_STATIC_DIR: staticDir });
    expect((await server.closed).code).toBe(1);
    expect(server.records()).toEqual([
      expect.objectContaining({ level: "error", msg: "data_dir_unusable", dataDir: missing }),
    ]);
  });

  it("exits 1 when AIA_ADMIN_TOKEN and AIA_ADMIN_TOKEN_FILE are both set", async () => {
    const tokenFile = join(scratch, "both-token");
    await writeFile(tokenFile, "file-s3cret\n");
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_ADMIN_TOKEN: "env-s3cret",
      AIA_ADMIN_TOKEN_FILE: tokenFile,
    });
    expect((await server.closed).code).toBe(1);
    expect(server.stderr()).toMatch(
      /AIA_ADMIN_TOKEN: set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE/
    );
    expect(server.stderr()).not.toMatch(/s3cret/);
    expect(server.stdout()).toBe("");
  });

  it("exits 1 when an _FILE variable names a file that cannot be read", async () => {
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_UPLOAD_TOKEN_FILE: join(scratch, "no-such-token"),
    });
    expect((await server.closed).code).toBe(1);
    expect(server.stderr()).toMatch(/AIA_UPLOAD_TOKEN_FILE: cannot read/);
  });

  it("exits 1 with a JSON error log when the port is taken", async () => {
    const blocker = createServer();
    blocker.listen(0);
    await once(blocker, "listening");
    try {
      const { port } = blocker.address() as AddressInfo;
      const server = start({
        PORT: String(port),
        AIA_DATA_DIR: await freshDataDir(),
        AIA_STATIC_DIR: staticDir,
      });
      expect((await server.closed).code).toBe(1);
      const errors = server.records().filter((record) => record.level === "error");
      expect(errors.map((record) => record.msg)).toEqual(["server_error"]);
      expect((errors[0]?.error as { message?: unknown } | undefined)?.message).toMatch(
        /EADDRINUSE/
      );
      expect(server.records().map((record) => record.msg)).not.toContain("listening");
    } finally {
      blocker.close();
    }
  });
});

describe("node src/runtime/node.ts shutdown and degraded start-up", { timeout: TIMEOUT }, () => {
  it("exits 0 on SIGTERM well within 5 s while sockets hold no complete request", async () => {
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_STATIC_DIR: staticDir,
    });
    const port = await server.listening;
    // A preconnect that sends nothing, a client stuck in its header block, and an idle
    // keep-alive connection after one complete request.
    const preconnect = await openSocket(port);
    const partial = await openSocket(port);
    partial.write(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    const keepAlive = await openSocket(port);
    keepAlive.write(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    await once(keepAlive, "data");
    // Let the server take in the other two sockets' bytes before the signal.
    await sleep(200);
    const sockets = [preconnect, partial, keepAlive];
    const socketsClosed = Promise.all(sockets.map((socket) => once(socket, "close")));

    const started = performance.now();
    server.child.kill("SIGTERM");
    expect(await server.closed).toEqual({ code: 0, signal: null });
    expect(performance.now() - started).toBeLessThan(5_000);
    await socketsClosed;
    const messages = server.records().map((record) => record.msg);
    expect(messages.slice(-2)).toEqual(["shutdown", "closed"]);
  });

  it("keeps serving without index.html", async () => {
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_STATIC_DIR: "dist/no-such-static-dir",
    });
    const port = await server.listening;

    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(health.status).toBe(200);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(404);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/plain/);

    server.child.kill("SIGTERM");
    expect((await server.closed).code).toBe(0);
  });
});

describe("_FILE variants", { timeout: TIMEOUT }, () => {
  it("reads the file and drops one trailing newline", async () => {
    const tokenFile = join(scratch, "admin-token");
    await writeFile(tokenFile, "s3cret-from-file\n");
    // The same reader as src/runtime/node.ts.
    const resolved = resolveFileVariants({ AIA_ADMIN_TOKEN_FILE: tokenFile }, (path) =>
      readFileSync(path, "utf8")
    );
    expect(resolved).toEqual({ ok: true, value: { AIA_ADMIN_TOKEN: "s3cret-from-file" } });
    const settings = resolved.ok ? parseSettings(resolved.value) : resolved;
    expect(settings.ok && settings.value.app.adminToken).toBe("s3cret-from-file");
  });

  it("starts with a token from a file and never logs it", async () => {
    const tokenFile = join(scratch, "upload-token");
    await writeFile(tokenFile, "s3cret-from-file\r\n");
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_STATIC_DIR: staticDir,
      AIA_ADMIN_TOKEN_FILE: tokenFile,
    });
    const port = await server.listening;
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
    server.child.kill("SIGTERM");
    expect((await server.closed).code).toBe(0);
    expect(server.stdout() + server.stderr()).not.toContain("s3cret");
  });

  it("strips the newline before validating: a file holding only a newline is an empty token", async () => {
    const tokenFile = join(scratch, "empty-token");
    await writeFile(tokenFile, "\n");
    const server = start({
      PORT: "0",
      AIA_DATA_DIR: await freshDataDir(),
      AIA_ADMIN_TOKEN_FILE: tokenFile,
    });
    expect((await server.closed).code).toBe(1);
    expect(server.stderr()).toMatch(/AIA_ADMIN_TOKEN: must not be empty when set/);
  });
});
