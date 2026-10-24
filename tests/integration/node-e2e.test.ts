// The Node entry and the CLI as real processes: `node src/runtime/node.ts` (type stripping) with
// PORT=0, a temporary data directory, a temporary static directory standing in for dist/web and
// the admin token in a file, driven by `node src/cli/aia.ts` and fetch over the socket.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/digest.ts";
import { cert, crlEntry, fixturePath } from "../fixtures/pki.ts";
import type { LogLine } from "../helpers/app.ts";
import { configFor } from "../helpers/catalog.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = fileURLToPath(new URL("../../src/runtime/node.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../src/cli/aia.ts", import.meta.url));
const TOKEN = "e2e-s3cret-admin-token";
const INDEX_HTML = "<!doctype html><title>aia-cdp test UI</title>\n";
const SCRIPT = "export const ui = 1;\n";
const CRL_01 = "crls/root-ca/full-01.der";
const CRL_02 = "crls/root-ca/full-02.der";
const TIMEOUT = 30_000;

interface Proc {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  /** The exit code, once the output has been read to the end. */
  closed: Promise<number | null>;
}

const running = new Set<Proc>();
let scratch: string;
let staticDir: string;

/** Runs a Node script with exactly `env` (plus PATH): no AIA_* leaks in from the caller's shell. */
function spawnNode(script: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const proc: Proc = { child, stdout: "", stderr: "", closed };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    proc.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    proc.stderr += chunk;
  });
  running.add(proc);
  return proc;
}

/** Every stdout line, parsed (throws on a line that is not JSON). */
function records(proc: Proc): LogLine[] {
  return proc.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

/** The port of the server's `listening` line; rejects if the process ends first. */
function listening(proc: Proc): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.child.stdout.on("data", () => {
      const match = /"msg":"listening","port":(\d+)\}\n/.exec(proc.stdout);
      if (match) {
        resolve(Number(match[1]));
      }
    });
    void proc.closed.then((code) => {
      reject(new Error(`exited with ${code} before listening\n${proc.stdout}${proc.stderr}`));
    });
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-node-e2e-"));
  staticDir = join(scratch, "web");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), INDEX_HTML);
  await writeFile(join(staticDir, "assets", "index-abc.js"), SCRIPT);
});

afterAll(async () => {
  for (const proc of running) {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill("SIGKILL");
    }
    // No data directory is removed under a running server.
    await proc.closed;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("node src/runtime/node.ts driven by the aia CLI", { timeout: TIMEOUT }, () => {
  let server: Proc;
  let port: number;
  let base: string;
  let env: Record<string, string>;
  let dataDir: string;

  /** The CLI to completion; it never prints the token. */
  const aia = async (...args: string[]) => {
    const proc = spawnNode(CLI, args, env);
    const code = await proc.closed;
    expect(proc.stdout + proc.stderr).not.toContain(TOKEN);
    return { code, stdout: proc.stdout, stderr: proc.stderr };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(scratch, "data-"));
    const tokenFile = join(scratch, "admin-token");
    await writeFile(tokenFile, `${TOKEN}\n`);
    server = spawnNode(SERVER, [], {
      PORT: "0",
      AIA_DATA_DIR: dataDir,
      AIA_STATIC_DIR: staticDir,
      AIA_ADMIN_TOKEN_FILE: tokenFile,
    });
    port = await listening(server);
    base = `http://127.0.0.1:${port}`;
    env = { AIA_URL: base, AIA_ADMIN_TOKEN_FILE: tokenFile };
  }, TIMEOUT);

  it("listens on the port PORT=0 picked and reports degraded until configured", async () => {
    expect(records(server)[0]).toEqual({ level: "info", msg: "listening", port });
    expect(await aia("health")).toEqual({
      code: 1,
      stdout: "degraded: store ok, configuration missing\n",
      stderr: "",
    });
  });

  it("imports certificates and applies a configuration, then reports healthy", async () => {
    const files = [fixturePath(cert("root-ca").der), fixturePath(cert("issuing-ca-1").pem)];
    const imported = await aia("import", ...files);
    expect(imported.stderr).toBe("");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toMatch(/\n2 created, 0 unchanged, 0 failed\n$/);

    const file = join(scratch, "config.json");
    await writeFile(file, JSON.stringify(configFor(["root-ca", "issuing-ca-1"])));
    const applied = await aia("config", "apply", "--json", file);
    expect(applied.code).toBe(0);
    const stored = await readFile(join(dataDir, "config.json"));
    expect((JSON.parse(applied.stdout) as { etag: string }).etag).toBe(
      `"${await sha256Hex(stored)}"`
    );

    expect(await aia("health")).toEqual({
      code: 0,
      stdout: "healthy: store ok, configuration ok\n",
      stderr: "",
    });
  });

  it("publishes a CRL, refuses an older one with exit 1, and serves the newer", async () => {
    const created = await aia("publish", fixturePath(CRL_02));
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/^created {4}[0-9a-f-]{36} {2}full #/);
    const stale = await aia("publish", fixturePath(CRL_01));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/: HTTP 409 stale_crl: /);

    const res = await fetch(`${base}/crl/root-ca.crl`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pkix-crl");
    expect(res.headers.get("ETag")).toBe(`"${crlEntry(CRL_02).sha256}"`);
    expect(Buffer.from(await res.arrayBuffer()).equals(await readFile(fixturePath(CRL_02)))).toBe(
      true
    );
  });

  it("serves a certificate download, GET and HEAD", async () => {
    const der = await readFile(fixturePath(cert("root-ca").der));
    const tag = `"${cert("root-ca").sha256}"`;
    const url = `${base}/ca/root-ca.crt`;
    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("application/pkix-cert");
    expect(get.headers.get("ETag")).toBe(tag);
    expect(get.headers.get("Content-Length")).toBe(String(der.byteLength));
    expect(Buffer.from(await get.arrayBuffer()).equals(der)).toBe(true);

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(der.byteLength));
    expect(head.headers.get("ETag")).toBe(tag);
    expect(await head.text()).toBe("");
  });

  it("answers the read API and serves the UI from the static directory", async () => {
    const crls = await fetch(`${base}/api/v1/crls`);
    expect(crls.headers.get("Cache-Control")).toBe("no-store");
    const targets = (await crls.json()) as { current: { sha256: string } | null }[];
    expect(targets).toHaveLength(2);
    expect(targets.flatMap((target) => (target.current ? [target.current.sha256] : []))).toEqual([
      crlEntry(CRL_02).sha256,
    ]);

    const page = await fetch(`${base}/crls/${crypto.randomUUID()}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-cache");
    expect(await page.text()).toBe(INDEX_HTML);
    const script = await fetch(`${base}/assets/index-abc.js`);
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe(SCRIPT);
    const missing = await fetch(`${base}/assets/missing.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  });

  it("exits 0 on SIGTERM within 5 s although a socket never finished its request", async () => {
    const slow = connect(port, "127.0.0.1");
    slow.on("error", () => undefined);
    await once(slow, "connect");
    slow.write("GET / HTTP/1.1\r\nHost: x\r\n");
    const started = performance.now();
    server.child.kill("SIGTERM");
    expect(await server.closed).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);

    // Every stdout line is a JSON log record; the token is never logged.
    const messages = records(server).map((record) => record.msg);
    expect(messages).toContain("request");
    expect(messages.slice(-2)).toEqual(["shutdown", "closed"]);
    expect(server.stderr).toBe("");
    expect(server.stdout).not.toContain(TOKEN);
  });
});

describe("node src/runtime/node.ts start-up failures", { timeout: TIMEOUT }, () => {
  it("exits 1 on an invalid setting, naming it on stderr", async () => {
    const proc = spawnNode(SERVER, [], { PORT: "abc", AIA_DATA_DIR: scratch });
    expect(await proc.closed).toBe(1);
    expect(proc.stderr).toMatch(/^Invalid settings:\n {2}PORT: /);
    expect(proc.stdout).toBe("");
  });

  it("exits 1 with a JSON error log when the data directory does not exist", async () => {
    const missing = join(scratch, "no-such-dir");
    const proc = spawnNode(SERVER, [], { PORT: "0", AIA_DATA_DIR: missing });
    expect(await proc.closed).toBe(1);
    expect(records(proc)).toEqual([
      expect.objectContaining({ level: "error", msg: "data_dir_unusable", dataDir: missing }),
    ]);
  });
});
