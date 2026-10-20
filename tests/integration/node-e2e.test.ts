// The CLI against the Node runtime, all real processes on the fs store (implementation slice 2,
// exit 4): `node src/runtime/node.ts` with a temporary AIA_DATA_DIR, PORT=0 and
// AIA_ADMIN_TOKEN_FILE, driven by `node src/cli/aia.ts` children: import ×3 → config apply → health
// healthy → restart → the same ETag, every re-import unchanged. Also scripts/seed-dev.ts, twice.
// Slices 3 and 4 continue this file (downloads, publish).
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { fixturePath } from "../fixtures/pki.ts";
import { cert } from "../helpers/catalog.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = fileURLToPath(new URL("../../src/runtime/node.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../src/cli/aia.ts", import.meta.url));
const SEED = fileURLToPath(new URL("../../scripts/seed-dev.ts", import.meta.url));
const TOKEN = "e2e-s3cret-admin-token";
const TIMEOUT = 30_000;
const CAS = ["root-ca", "issuing-ca-1", "issuing-ca-2"];

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Server {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  output: () => string;
  /** SIGTERM; resolves to the exit code. */
  stop: () => Promise<number | null>;
}

const servers = new Set<Server>();
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-node-e2e-"));
});

afterAll(async () => {
  for (const server of servers) {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
    }
  }
  await rm(scratch, { recursive: true, force: true });
});

/** Starts the Node entry with exactly `env` (plus PATH); resolves once it is listening. */
async function startServer(env: Record<string, string>): Promise<Server> {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", PORT: "0", AIA_STATIC_DIR: scratch, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const match = /"msg":"listening","port":(\d+)/.exec(output);
      if (match) {
        resolve(Number(match[1]));
      }
    });
    void closed.then((code) => {
      reject(new Error(`server exited with ${code} before listening\n${output}`));
    });
  });
  const server: Server = {
    child,
    port,
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      return closed;
    },
  };
  servers.add(server);
  return server;
}

/** Runs a Node script to completion with exactly `env` (plus PATH). */
async function runNode(script: string, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const result: Result = { code, stdout, stderr };
  // Neither the CLI nor the seed ever prints the token.
  expect(stdout + stderr).not.toContain(TOKEN);
  return result;
}

/** A configuration serving the three CAs: /ca/<name>.crt and a full CRL target each. */
function threeCaConfig(): Config {
  const config: Config = { version: 1, certificates: {}, targets: {}, paths: {} };
  for (const name of CAS) {
    const id = cert(name).sha256;
    const target = crypto.randomUUID();
    config.certificates[id] = { label: name };
    config.targets[target] = { issuer: id, kind: "full", label: name };
    config.paths[`/ca/${name}.crt`] = { certificate: id };
    config.paths[`/crl/${name}.crl`] = { target };
  }
  return config;
}

describe("aia against node src/runtime/node.ts on the fs store", { timeout: TIMEOUT }, () => {
  let dataDir: string;
  let env: Record<string, string>;
  let server: Server;
  let etag: string;
  // DER and PEM files, as an operator would have them.
  const files = [
    fixturePath(cert("root-ca").der),
    fixturePath(cert("issuing-ca-1").pem),
    fixturePath(cert("issuing-ca-2").der),
  ];

  const aia = (...args: string[]) => runNode(CLI, args, env);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(scratch, "data-"));
    const tokenFile = join(scratch, "admin-token");
    await writeFile(tokenFile, `${TOKEN}\n`);
    server = await startServer({ AIA_DATA_DIR: dataDir, AIA_ADMIN_TOKEN_FILE: tokenFile });
    env = { AIA_URL: `http://127.0.0.1:${server.port}`, AIA_ADMIN_TOKEN_FILE: tokenFile };
  }, TIMEOUT);

  it("imports three certificates", async () => {
    const run = await aia("import", ...files);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    CAS.forEach((name, index) => {
      expect(lines[index]).toMatch(new RegExp(`^created    ${cert(name).sha256}  `));
    });
    expect(lines[3]).toBe("3 created, 0 unchanged, 0 failed");
  });

  it("applies a configuration, stored under the returned ETag", async () => {
    const file = join(scratch, "config.json");
    await writeFile(file, JSON.stringify(threeCaConfig()));
    const run = await aia("config", "apply", "--json", file);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    etag = (JSON.parse(run.stdout) as { etag: string }).etag;
    const stored = await readFile(join(dataDir, "config.json"));
    expect(etag).toBe(`"${await sha256Hex(stored)}"`);
  });

  it("reports healthy", async () => {
    expect(await aia("health")).toEqual({
      code: 0,
      stdout: "healthy: store ok, configuration ok\n",
      stderr: "",
    });
  });

  it("keeps everything across a restart: the same ETag, every re-import unchanged", async () => {
    expect(await server.stop()).toBe(0);
    server = await startServer({
      AIA_DATA_DIR: dataDir,
      AIA_ADMIN_TOKEN_FILE: env.AIA_ADMIN_TOKEN_FILE ?? "",
    });
    env = { ...env, AIA_URL: `http://127.0.0.1:${server.port}` };

    const shown = await aia("config", "show", "--json");
    expect(shown.code).toBe(0);
    expect((JSON.parse(shown.stdout) as { etag: string }).etag).toBe(etag);

    const again = await aia("import", ...files);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^unchanged .*\nunchanged .*\nunchanged .*\n/);
    expect(again.stdout).toMatch(/\n0 created, 3 unchanged, 0 failed\n$/);
    expect(await aia("health")).toMatchObject({ code: 0 });

    expect(await server.stop()).toBe(0);
    expect(server.output()).not.toContain(TOKEN);
  });
});

describe("scripts/seed-dev.ts against node src/runtime/node.ts", { timeout: TIMEOUT }, () => {
  it("seeds once, then reports everything unchanged and leaves the config alone", async () => {
    const dataDir = await mkdtemp(join(scratch, "seed-"));
    const server = await startServer({ AIA_DATA_DIR: dataDir, AIA_ADMIN_TOKEN: TOKEN });
    const env = { AIA_URL: `http://127.0.0.1:${server.port}`, AIA_ADMIN_TOKEN: TOKEN };

    const first = await runNode(SEED, [], env);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/3 created, 0 unchanged, 0 failed\n/);
    expect(first.stdout).toMatch(/\napplied <seed-dev config> \(ETag "[0-9a-f]{64}"\)\n$/);
    const config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as Config;
    expect(Object.keys(config.paths).sort()).toEqual([
      "/ca/issuing-ca-1.crt",
      "/ca/issuing-ca-2.crt",
      "/ca/root-ca.crt",
      "/crl/issuing-ca-1.crl",
      "/crl/issuing-ca-2.crl",
      "/crl/root-ca.crl",
      "/dcrl/issuing-ca-1.crl",
      "/dcrl/issuing-ca-2.crl",
    ]);
    expect(Object.keys(config.targets)).toHaveLength(5);

    const before = await readFile(join(dataDir, "config.json"));
    const second = await runNode(SEED, [], env);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/0 created, 3 unchanged, 0 failed\n/);
    expect(second.stdout).toMatch(/config\.json exists, not applied/);
    expect(await readFile(join(dataDir, "config.json"))).toEqual(before);

    expect(await runNode(CLI, ["health"], env)).toMatchObject({ code: 0 });
    expect(await server.stop()).toBe(0);
  });
});
