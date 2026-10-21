// The CLI against the Node runtime, all real processes on the fs store (implementation slice 2,
// exit 4): `node src/runtime/node.ts` with a temporary AIA_DATA_DIR, PORT=0, AIA_ADMIN_TOKEN_FILE
// and AIA_UPLOAD_TOKEN_FILE, driven by `node src/cli/aia.ts` children: import ×3 → config apply →
// health healthy → downloads (slice 3: GET / HEAD / 304, unpublished CRL 404) → publish (slice 4:
// root-ca full-01 created, again unchanged, full-02 updated, full-01 stale; the path table serves
// full-02) → the read routes (slice 5a: lists, details, stats, HEAD) → restart → the same ETags,
// every re-import unchanged. Also scripts/seed-dev.ts, twice.
import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { fixturePath, manifest } from "../fixtures/pki.ts";
import { cert } from "../helpers/catalog.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = fileURLToPath(new URL("../../src/runtime/node.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../src/cli/aia.ts", import.meta.url));
const SEED = fileURLToPath(new URL("../../scripts/seed-dev.ts", import.meta.url));
const TOKEN = "e2e-s3cret-admin-token";
const UPLOAD_TOKEN = "e2e-s3cret-upload-token";
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

/** Every server process from its spawn on, so that afterAll ends it even if it never listened. */
const processes = new Set<{ child: ChildProcess; closed: Promise<unknown> }>();
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-node-e2e-"));
});

afterAll(async () => {
  for (const { child, closed } of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    // No data directory is removed under a running server.
    await closed;
  }
  await rm(scratch, { recursive: true, force: true });
});

/** The port of a complete stdout line that is the `listening` log record. */
function listeningPort(line: string): number | undefined {
  try {
    const record = JSON.parse(line) as { msg?: unknown; port?: unknown };
    return record.msg === "listening" && typeof record.port === "number" ? record.port : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the Node entry with exactly `env` (plus PATH); resolves once it is listening. */
async function startServer(env: Record<string, string>): Promise<Server> {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", PORT: "0", AIA_STATIC_DIR: scratch, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });
  processes.add({ child, closed });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const port = await new Promise<number>((resolve, reject) => {
    let scanned = 0;
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      // Complete lines only: a chunk may end in the middle of one.
      const end = stdout.lastIndexOf("\n") + 1;
      for (const line of stdout.slice(scanned, end).split("\n")) {
        const found = listeningPort(line);
        if (found !== undefined) {
          resolve(found);
        }
      }
      scanned = Math.max(scanned, end);
    });
    void closed.then((code) => {
      reject(new Error(`server exited with ${code} before listening\n${stdout}${stderr}`));
    });
  });
  return {
    child,
    port,
    output: () => stdout + stderr,
    stop: async () => {
      child.kill("SIGTERM");
      return closed;
    },
  };
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
  // Neither the CLI nor the seed ever prints a token.
  expect(stdout + stderr).not.toContain(TOKEN);
  expect(stdout + stderr).not.toContain(UPLOAD_TOKEN);
  return result;
}

const ROOT_FULL_01 = "crls/root-ca/full-01.der";
const ROOT_FULL_02 = "crls/root-ca/full-02.der";

function crlEntry(file: string) {
  const found = manifest.crls.find((crl) => crl.file === file);
  if (found === undefined) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found;
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
  let serverEnv: Record<string, string>;
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
    const uploadTokenFile = join(scratch, "upload-token");
    await writeFile(tokenFile, `${TOKEN}\n`);
    await writeFile(uploadTokenFile, `${UPLOAD_TOKEN}\n`);
    serverEnv = {
      AIA_DATA_DIR: dataDir,
      AIA_ADMIN_TOKEN_FILE: tokenFile,
      AIA_UPLOAD_TOKEN_FILE: uploadTokenFile,
    };
    server = await startServer(serverEnv);
    env = {
      AIA_URL: `http://127.0.0.1:${server.port}`,
      AIA_ADMIN_TOKEN_FILE: tokenFile,
      AIA_UPLOAD_TOKEN_FILE: uploadTokenFile,
    };
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

  // Slice 3's manual exit check, automated: what the CLI configured is what download clients get.
  it("serves the configured certificates: GET, HEAD and 304; an unpublished CRL is a text 404", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    for (const name of CAS) {
      const der = await readFile(fixturePath(cert(name).der));
      const tag = `"${cert(name).sha256}"`;
      const url = `${base}/ca/${name}.crt`;

      const get = await fetch(url);
      expect(get.status).toBe(200);
      expect(get.headers.get("Content-Type")).toBe("application/pkix-cert");
      expect(get.headers.get("ETag")).toBe(tag);
      expect(get.headers.get("Content-Length")).toBe(String(der.byteLength));
      expect(Buffer.from(await get.arrayBuffer()).equals(der)).toBe(true);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("ETag")).toBe(tag);
      expect(head.headers.get("Content-Length")).toBe(String(der.byteLength));

      const revalidated = await fetch(url, { headers: { "If-None-Match": tag } });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("ETag")).toBe(tag);

      const crl = await fetch(`${base}/crl/${name}.crl`);
      expect(crl.status).toBe(404);
      expect(crl.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await crl.text()).toBe("Not Found");
    }

    const pem = await fetch(`${base}/ca/root-ca.crt.pem`);
    expect(pem.status).toBe(200);
    expect(pem.headers.get("ETag")).toBe(`"${cert("root-ca").sha256}-pem"`);
    expect(await pem.text()).toBe(await readFile(fixturePath(cert("root-ca").pem), "utf8"));
  });

  // Slice 4's CLI sequence (the old helper's root CA path): exit 0 for created / unchanged /
  // updated, 1 for the stale re-upload, and the path table serves what was published last.
  it("publishes root-ca's CRLs: created, unchanged, updated, then stale", async () => {
    const root = cert("root-ca").sha256;
    const config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as Config;
    const target = Object.keys(config.targets).find((id) => config.targets[id]?.issuer === root);
    const full01 = fixturePath(ROOT_FULL_01);
    const full02 = fixturePath(ROOT_FULL_02);
    const number = (file: string) => crlEntry(file).crlNumber ?? "";

    const created = await aia("publish", full01);
    expect(created).toEqual({
      code: 0,
      stdout:
        `created    ${target}  full #${number(ROOT_FULL_01)}  ${full01}\n` +
        "1 created, 0 updated, 0 unchanged, 0 failed\n",
      stderr: "",
    });
    const unchanged = await aia("publish", full01);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toMatch(/^unchanged {2}/);
    const updated = await aia("publish", full02);
    expect(updated.code).toBe(0);
    expect(updated.stdout).toBe(
      `updated    ${target}  full #${number(ROOT_FULL_02)}  ${full02}\n` +
        "0 created, 1 updated, 0 unchanged, 0 failed\n"
    );
    const stale = await aia("publish", full01);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(new RegExp(`^failed     ${full01}: HTTP 409 stale_crl: `));
    expect(stale.stdout).toBe("0 created, 0 updated, 0 unchanged, 1 failed\n");

    const res = await fetch(`http://127.0.0.1:${server.port}/crl/root-ca.crl`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pkix-crl");
    const sha256 = crlEntry(ROOT_FULL_02).sha256;
    expect(res.headers.get("ETag")).toBe(`"${sha256}"`);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("Content-Length")).toBe(String(body.byteLength));
    expect(await sha256Hex(body)).toBe(sha256);
  });

  // Slice 5a: what the public read routes say about the same state, over a real socket.
  it("reads the certificates, targets and stats back through the API, GET and HEAD", async () => {
    const base = `http://127.0.0.1:${server.port}/api/v1`;
    /** A 200 JSON body, no-store; typed as far as these checks need. */
    const read = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toMatch(/^application\/json/);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      return (await res.json()) as T;
    };
    const config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as Config;
    const rootTarget = Object.keys(config.targets).find(
      (id) => config.targets[id]?.issuer === cert("root-ca").sha256
    );

    const certificates =
      await read<{ id: string; label: string | null; downloads: string[] }[]>("/certificates");
    expect(certificates.map((item) => item.id)).toEqual(
      CAS.map((name) => cert(name).sha256).sort()
    );
    for (const name of CAS) {
      expect(certificates.find((item) => item.id === cert(name).sha256)).toMatchObject({
        label: name,
        downloads: [`/ca/${name}.crt`, `/ca/${name}.crt.pem`],
      });
    }
    const root = await read<{
      fingerprints: { sha256: string };
      tbsCertificate: { serialNumber: { hex: string } };
    }>(`/certificates/${cert("root-ca").sha256.toUpperCase()}`);
    expect(root.fingerprints.sha256).toBe(cert("root-ca").sha256);
    expect(root.tbsCertificate.serialNumber.hex).toBe(cert("root-ca").serial);

    const targets = await read<{ targetId: string; current: { sha256: string } | null }[]>("/crls");
    expect(targets.map((item) => item.targetId)).toEqual(Object.keys(config.targets).sort());
    for (const item of targets) {
      expect(item.current?.sha256 ?? null).toBe(
        item.targetId === rootTarget ? crlEntry(ROOT_FULL_02).sha256 : null
      );
    }
    const detail = await read<{
      current: { verifier: string; tbsCertList: { revokedCertificates: { count: number } } };
    }>(`/crls/${rootTarget}`);
    expect(detail.current.verifier).toBe(cert("root-ca").sha256);
    expect(detail.current.tbsCertList.revokedCertificates.count).toBe(
      crlEntry(ROOT_FULL_02).revoked
    );

    const sizes = await Promise.all(
      [...CAS.map((name) => cert(name).der), ROOT_FULL_02].map(
        async (file) => (await readFile(fixturePath(file))).byteLength
      )
    );
    expect(await read("/stats")).toEqual({
      certificates: CAS.length,
      targets: { full: CAS.length, delta: 0 },
      published: { full: 1, delta: 0 },
      totalRevocations: crlEntry(ROOT_FULL_02).revoked,
      derBytes: sizes.reduce((sum, size) => sum + size, 0),
    });

    for (const path of ["/certificates", `/crls/${rootTarget}`, "/stats"]) {
      const head = await fetch(`${base}${path}`, { method: "HEAD" });
      expect(head.status, path).toBe(200);
      expect(head.headers.get("Cache-Control"), path).toBe("no-store");
      expect(head.headers.get("Content-Type"), path).toMatch(/^application\/json/);
      expect(await head.text(), path).toBe("");
    }
  });

  it("refuses an upload without the upload token", async () => {
    const run = await runNode(CLI, ["publish", fixturePath(ROOT_FULL_02)], {
      AIA_URL: env.AIA_URL ?? "",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/: HTTP 401 unauthorized: /);
  });

  it("keeps everything across a restart: the same ETags, every re-import unchanged", async () => {
    expect(await server.stop()).toBe(0);
    server = await startServer(serverEnv);
    env = { ...env, AIA_URL: `http://127.0.0.1:${server.port}` };

    const shown = await aia("config", "show", "--json");
    expect(shown.code).toBe(0);
    expect((JSON.parse(shown.stdout) as { etag: string }).etag).toBe(etag);

    const again = await aia("import", ...files);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^unchanged .*\nunchanged .*\nunchanged .*\n/);
    expect(again.stdout).toMatch(/\n0 created, 3 unchanged, 0 failed\n$/);
    expect(await aia("health")).toMatchObject({ code: 0 });
    const crl = await fetch(`http://127.0.0.1:${server.port}/crl/root-ca.crl`, { method: "HEAD" });
    expect(crl.headers.get("ETag")).toBe(`"${crlEntry(ROOT_FULL_02).sha256}"`);
    const republished = await aia("publish", fixturePath(ROOT_FULL_02));
    expect(republished.stdout).toMatch(/^unchanged {2}/);

    expect(await server.stop()).toBe(0);
    expect(server.output()).not.toContain(TOKEN);
    expect(server.output()).not.toContain(UPLOAD_TOKEN);
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
    expect(first.stdout).toMatch(/\napplied <seed-dev config> \(ETag "[0-9a-f]{64}"\)\n/);
    expect(first.stdout).toMatch(/\n4 created, 0 updated, 0 unchanged, 0 failed\n$/);
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
    // Every target has its CRL but issuing-ca-2's delta, which scripts/ui-smoke.ts uploads.
    const targets = (await (await fetch(`${env.AIA_URL}/api/v1/crls`)).json()) as {
      kind: string;
      issuer: { id: string };
      current: unknown;
    }[];
    const unpublished = targets.filter((target) => target.current === null);
    expect(unpublished).toMatchObject([
      { kind: "delta", issuer: { id: cert("issuing-ca-2").sha256 } },
    ]);

    const before = await readFile(join(dataDir, "config.json"));
    const second = await runNode(SEED, [], env);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/0 created, 3 unchanged, 0 failed\n/);
    expect(second.stdout).toMatch(/config\.json exists, not applied/);
    expect(second.stdout).toMatch(/\n0 created, 0 updated, 4 unchanged, 0 failed\n$/);
    expect(await readFile(join(dataDir, "config.json"))).toEqual(before);

    expect(await runNode(CLI, ["health"], env)).toMatchObject({ code: 0 });
    expect(await server.stop()).toBe(0);
  });
});
