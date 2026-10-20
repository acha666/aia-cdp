// The CLI in process (implementation slice 2 step 9, slice 4 step 9): main() with fetch =
// app.request over a MemoryStore, so every subcommand's output and exit code is checked without a
// socket. Real processes on the fs store are tests/integration/node-e2e.test.ts.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, USAGE } from "../../src/cli/aia.ts";
import type { CliIo } from "../../src/cli/aia.ts";
import { checkConfigStatic } from "../../src/core/admin.ts";
import { CONFIG_KEY, TargetId } from "../../src/core/catalog.ts";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { createApp } from "../../src/http/app.ts";
import { fixturePath, manifest } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, patchStore, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { cert } from "../helpers/catalog.ts";
import { setupPublish } from "../helpers/publish.ts";

const TOKEN = "cli-s3cret-token";
const UPLOAD_TOKEN = "cli-upload-s3cret";
const BASE = "https://aia.test";
const ENV = { AIA_URL: BASE, AIA_ADMIN_TOKEN: TOKEN };
const EXAMPLE = fileURLToPath(new URL("../../docs/config.example.json", import.meta.url));

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-cli-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Writes a file into the scratch directory and returns its path. */
async function scratchFile(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, content);
  return path;
}

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

interface Sent {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  /** The body as sent, byte for byte. */
  bytes: Uint8Array;
}

/** createApp with the admin token set, and a fetch that records every request it forwards. */
function service(overrides: TestOverrides = {}) {
  const deps = testDeps({
    sleep: async () => undefined,
    ...overrides,
    settings: { adminToken: TOKEN, ...overrides.settings },
  });
  const app = createApp(deps);
  const sent: Sent[] = [];
  const fetch: CliIo["fetch"] = async (url, init) => {
    const request = new Request(url, init);
    sent.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.clone().text(),
      bytes: new Uint8Array(await request.clone().arrayBuffer()),
    });
    return app.request(request);
  };
  return { deps, app, fetch, sent };
}

type Service = ReturnType<typeof service>;

/**
 * A response whose body fails while it is read, as after a connection reset or when the request
 * timeout fires mid-body.
 */
function brokenResponse(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("socket reset"));
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch that must not be called. */
const offline: CliIo["fetch"] = () => {
  throw new Error("this command must not touch the network");
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function aia(
  argv: string[],
  io: Partial<Pick<CliIo, "fetch" | "env" | "readFile">> = {}
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    fetch: io.fetch ?? offline,
    env: io.env ?? {},
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    readFile: io.readFile ?? ((path) => readFile(path)),
  });
  // Never echoed, whatever happened.
  expect(stdout + stderr).not.toContain(TOKEN);
  expect(stdout + stderr).not.toContain(UPLOAD_TOKEN);
  return { code, stdout, stderr };
}

/** aia against `svc` with AIA_URL and AIA_ADMIN_TOKEN set. */
function against(svc: Service, argv: string[], env: Record<string, string> = ENV) {
  return aia(argv, { fetch: svc.fetch, env });
}

/** A configuration serving the given certificate fixtures with a full CRL target each. */
function configFor(names: string[]): Config {
  const config: Config = { version: 1, certificates: {}, targets: {}, paths: {} };
  for (const name of names) {
    const id = cert(name).sha256;
    const target = crypto.randomUUID();
    config.certificates[id] = { label: name };
    config.targets[target] = { issuer: id, kind: "full", label: name };
    config.paths[`/ca/${name}.crt`] = { certificate: id };
    config.paths[`/crl/${name}.crl`] = { target };
  }
  return config;
}

async function configFile(name: string, config: unknown): Promise<string> {
  return scratchFile(name, `${JSON.stringify(config, null, 2)}\n`);
}

async function storedConfig(svc: Service): Promise<Uint8Array | undefined> {
  return (await svc.deps.store.get(CONFIG_KEY))?.bytes;
}

describe("usage", () => {
  it.each([["--help"], ["-h"], ["help"], ["health", "--help"]])(
    "%s prints the usage on stdout and exits 0",
    async (...argv) => {
      expect(await aia(argv)).toEqual({ code: 0, stdout: USAGE, stderr: "" });
    }
  );

  it.each([
    [[], /missing command/],
    [["frobnicate"], /unknown command "frobnicate"/],
    [["import"], /import needs at least one file/],
    [["config"], /config needs show, validate or apply/],
    [["config", "edit"], /unknown config command "edit"/],
    [["config", "show", "extra"], /usage: aia config show/],
    [["config", "validate"], /usage: aia config validate <file>/],
    [["config", "apply", "a.json", "b.json"], /usage: aia config apply <file>/],
    [["new-target-id", "x"], /usage: aia new-target-id/],
    [["publish"], /publish needs at least one file/],
    [["health", "--nope"], /Unknown option '--nope'/],
    [["health", "--url"], /--url/],
    [["health", "--json=yes"], /--json/],
  ])("%j → exit 2", async (argv, message) => {
    const run = await aia(argv, { env: ENV });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toMatch(/Run "aia --help" for usage\.\n$/);
  });

  it("needs a service URL for every command that talks to the service", async () => {
    for (const argv of [
      ["health"],
      ["import", "x.der"],
      ["config", "show"],
      ["publish", "x.crl"],
    ]) {
      const run = await aia(argv, { env: { AIA_ADMIN_TOKEN: TOKEN } });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/no service URL: pass --url or set AIA_URL/);
    }
  });

  it.each(["ftp://aia.test", "not a url", ""])("rejects --url %j", async (url) => {
    const run = await aia(["health", "--url", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/--url \/ AIA_URL|no service URL/);
  });

  it("needs an admin token for the admin commands, before reading any file", async () => {
    let read = 0;
    for (const argv of [
      ["import", "x.der"],
      ["config", "show"],
    ]) {
      const run = await aia(argv, {
        env: { AIA_URL: BASE },
        readFile: async () => {
          read += 1;
          return new Uint8Array();
        },
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/no admin token: pass --token-file/);
    }
    expect(read).toBe(0);
  });

  it("refuses AIA_ADMIN_TOKEN together with AIA_ADMIN_TOKEN_FILE, as the server does", async () => {
    const file = await scratchFile("both-token", `${TOKEN}\n`);
    const run = await aia(["config", "show"], {
      env: { ...ENV, AIA_ADMIN_TOKEN_FILE: file },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE, not both/);
  });

  it("refuses an empty, unreadable or malformed token without printing it", async () => {
    const empty = await scratchFile("empty-token", " \n\n");
    const cases: [Record<string, string>, RegExp][] = [
      [{ AIA_ADMIN_TOKEN_FILE: empty }, /the admin token in the token file .* is empty/],
      [{ AIA_ADMIN_TOKEN_FILE: join(scratch, "no-such-token") }, /cannot read the token file/],
      [{ AIA_ADMIN_TOKEN: `${TOKEN} $x` }, /has characters a bearer token cannot have/],
      [{ AIA_ADMIN_TOKEN: `${TOKEN}\nX-Injected: 1` }, /has characters a bearer token/],
    ];
    for (const [env, message] of cases) {
      const run = await aia(["config", "show"], { env: { AIA_URL: BASE, ...env } });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(message);
    }
  });
});

// The production host answers plain HTTP (AIA / CDP clients need it), so http://<host> reaches
// the service and would carry a token in clear text.
describe("tokens over plain http://", () => {
  const ROOT_CRL = fixturePath("crls/root-ca/full-01.der");

  it.each([
    "http://aia.test",
    "http://pki.example:8080/aia",
    "http://10.0.0.1",
    "http://127.0.0.1.nip.io",
    "http://localhost.example",
    "http://[::2]",
    "http://0.0.0.0",
  ])("refuses to send a token to %s: exit 2 before any request", async (url) => {
    let requests = 0;
    const fetch: CliIo["fetch"] = () => {
      requests += 1;
      return Promise.reject(new Error("sent"));
    };
    const admin = { AIA_URL: url, AIA_ADMIN_TOKEN: TOKEN };
    const upload = { AIA_URL: url, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN };
    const tokenFile = await scratchFile("http-upload-token", `${UPLOAD_TOKEN}\n`);
    const runs: [Run, string][] = [
      [await aia(["import", fixturePath(cert("root-ca").der)], { fetch, env: admin }), "admin"],
      [await aia(["config", "show"], { fetch, env: admin }), "admin"],
      [await aia(["config", "apply", EXAMPLE], { fetch, env: admin }), "admin"],
      [await aia(["publish", ROOT_CRL], { fetch, env: upload }), "upload"],
      [
        await aia(["publish", "--token-file", tokenFile, ROOT_CRL], {
          fetch,
          env: { AIA_URL: url },
        }),
        "upload",
      ],
    ];
    for (const [run, name] of runs) {
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(
        new RegExp(
          `^aia: refusing to send the ${name} token over http:// to \\S+: use https://, ` +
            "or pass --allow-insecure-http\n"
        )
      );
    }
    expect(requests).toBe(0);
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://127.1.2.3",
    "http://127.1",
    "http://localhost:8080",
    "http://LOCALHOST",
    "http://[::1]:8787",
    "http://[0:0:0:0:0:0:0:1]",
  ])("sends the tokens to the loopback host of %s", async (url) => {
    const svc = service({ settings: { uploadToken: UPLOAD_TOKEN } });
    await setupPublish(svc.deps.store);
    const imported = await aia(["import", fixturePath(cert("root-ca").der)], {
      fetch: svc.fetch,
      env: { AIA_URL: url, AIA_ADMIN_TOKEN: TOKEN },
    });
    expect(imported.code).toBe(0);
    const published = await aia(["publish", ROOT_CRL], {
      fetch: svc.fetch,
      env: { AIA_URL: url, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
    });
    expect(published.code).toBe(0);
    expect(svc.sent.map((request) => request.headers.get("Authorization"))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${UPLOAD_TOKEN}`,
    ]);
  });

  it("sends them to any host with --allow-insecure-http", async () => {
    const svc = service({ settings: { uploadToken: UPLOAD_TOKEN } });
    await setupPublish(svc.deps.store);
    const url = "http://aia.test";
    const imported = await aia(
      ["import", "--allow-insecure-http", fixturePath(cert("root-ca").der)],
      { fetch: svc.fetch, env: { AIA_URL: url, AIA_ADMIN_TOKEN: TOKEN } }
    );
    expect(imported.code).toBe(0);
    const published = await aia(["publish", "--allow-insecure-http", ROOT_CRL], {
      fetch: svc.fetch,
      env: { AIA_URL: url, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
    });
    expect(published.code).toBe(0);
    expect(svc.sent.map((request) => [request.url, request.headers.get("Authorization")])).toEqual([
      [`${url}/api/v1/admin/certificates`, `Bearer ${TOKEN}`],
      [`${url}/api/v1/crls`, `Bearer ${UPLOAD_TOKEN}`],
    ]);
  });

  it("checks nothing without a token: health, and publish to a service that needs none", async () => {
    const svc = service();
    await setupPublish(svc.deps.store);
    const env = { AIA_URL: "http://aia.test" };
    expect((await aia(["health"], { fetch: svc.fetch, env })).stderr).toBe("");
    const published = await aia(["publish", ROOT_CRL], { fetch: svc.fetch, env });
    expect(published.code).toBe(0);
    expect(svc.sent.map((request) => request.headers.get("Authorization"))).toEqual([null, null]);
  });
});

describe("health", () => {
  it("exits 1 while degraded and 0 once healthy, without sending the token", async () => {
    const svc = service();
    const degraded = await against(svc, ["health"]);
    expect(degraded).toEqual({
      code: 1,
      stdout: "degraded: store ok, configuration missing\n",
      stderr: "",
    });

    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    expect(await against(svc, ["health"])).toEqual({
      code: 0,
      stdout: "healthy: store ok, configuration ok\n",
      stderr: "",
    });
    expect(svc.sent.map((request) => request.headers.get("Authorization"))).toEqual([null, null]);
  });

  it("prints the report with --json", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    const run = await against(svc, ["health", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it("exits 1 when the service is unhealthy (503)", async () => {
    const svc = service({
      store: patchStore({ get: () => Promise.reject(new Error("disk on fire")) }),
    });
    expect(await against(svc, ["health"])).toEqual({
      code: 1,
      stdout: "unhealthy: store error, configuration unknown\n",
      stderr: "",
    });
  });

  it("exits 1 when the service cannot be reached, naming the cause", async () => {
    const run = await aia(["health"], {
      env: ENV,
      fetch: () =>
        Promise.reject(
          new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") })
        ),
    });
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "aia: cannot reach https://aia.test/api/v1/health: fetch failed " +
        "(connect ECONNREFUSED 127.0.0.1:1)\n",
    });
  });

  it("exits 1 on an answer that is not a health report", async () => {
    const run = await aia(["health"], {
      env: ENV,
      fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/did not answer with a health report \(HTTP 502\)/);
  });

  it.each([200, 503])("exits 1 when the body of a %i cannot be read", async (status) => {
    const run = await aia(["health"], { env: ENV, fetch: async () => brokenResponse(status) });
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr: "aia: cannot read the response from https://aia.test/api/v1/health: socket reset\n",
    });
  });

  it("keeps a path prefix of --url, which wins over AIA_URL", async () => {
    const urls: string[] = [];
    const run = await aia(["health", "--url", "https://pki.example/aia//"], {
      env: ENV,
      fetch: async (url) => {
        urls.push(url);
        return Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } });
      },
    });
    expect(run.code).toBe(0);
    expect(urls).toEqual(["https://pki.example/aia/api/v1/health"]);
  });
});

describe("import", () => {
  it("sends a DER file as application/pkix-cert, then its PEM is unchanged", async () => {
    const svc = service();
    const root = cert("root-ca");
    const created = await against(svc, ["import", fixturePath(root.der)]);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.stdout).toBe(
      `created    ${root.sha256}  Example Root CA (ECC P-384)  ${fixturePath(root.der)}\n` +
        "1 created, 0 unchanged, 0 failed\n"
    );
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]).toMatchObject({ method: "POST", url: `${BASE}/api/v1/admin/certificates` });
    expect(svc.sent[0]?.headers.get("Content-Type")).toBe("application/pkix-cert");
    expect(svc.sent[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);

    const unchanged = await against(svc, ["import", fixturePath(root.pem)]);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toMatch(new RegExp(`^unchanged  ${root.sha256}  `));
    expect(unchanged.stdout).toMatch(/0 created, 1 unchanged, 0 failed\n$/);
    expect(svc.sent[1]?.headers.get("Content-Type")).toBe("application/x-pem-file");
  });

  it("splits a PEM bundle and sends each certificate block on its own", async () => {
    const svc = service();
    const names = ["root-ca", "issuing-ca-1", "issuing-ca-2"];
    // Other labels (a key) are skipped and never sent; text around the blocks is ignored.
    const key =
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n";
    const [first, ...rest] = names.map((name) => text(cert(name).pem));
    const bundle = await scratchFile(
      "chain.pem",
      `Chain for example.test\n${first}${key}${rest.join("")}`
    );
    const run = await against(svc, ["import", bundle]);
    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    names.forEach((name, index) => {
      expect(lines[index]).toMatch(
        new RegExp(`^created    ${cert(name).sha256}  .*  ${bundle} \\[block ${index + 1}/3\\]$`)
      );
    });
    expect(lines[3]).toBe("3 created, 0 unchanged, 0 failed");
    expect(svc.sent).toHaveLength(3);
    for (const request of svc.sent) {
      expect(request.headers.get("Content-Type")).toBe("application/x-pem-file");
      expect(request.body.match(/-----BEGIN /g)).toEqual(["-----BEGIN "]);
      expect(request.body).not.toContain("PRIVATE KEY");
    }
  });

  it("isolates failures per file and per block, and summarizes", async () => {
    const svc = service();
    const badBlock = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n";
    const mixed = await scratchFile("mixed.pem", badBlock + text(cert("issuing-ca-1").pem));
    const noEnd = await scratchFile(
      "no-end.pem",
      text(cert("issuing-ca-2").pem).replace("-----END CERTIFICATE-----", "")
    );
    const missing = join(scratch, "missing.der");
    const garbage = fixturePath("invalid/garbage.txt");
    const crlPem = fixturePath("crls/root-ca/full-01.pem");
    const root = fixturePath(cert("root-ca").der);

    const run = await against(svc, ["import", garbage, missing, mixed, noEnd, crlPem, root]);
    expect(run.code).toBe(1);
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${garbage}: HTTP 422 invalid_certificate (der): Not a valid X.509 certificate`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${mixed} [block 1/2]: HTTP 422 invalid_certificate (pem_base64): ` +
        "Not a valid X.509 certificate",
      `failed     ${noEnd}: CERTIFICATE PEM block without an END line`,
      `failed     ${crlPem}: no CERTIFICATE PEM block`,
    ]);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      new RegExp(`^created    ${cert("issuing-ca-1").sha256}  .*  ${mixed} \\[block 2/2\\]$`)
    );
    expect(lines[1]).toMatch(new RegExp(`^created    ${cert("root-ca").sha256}  `));
    expect(lines[2]).toBe("2 created, 0 unchanged, 5 failed");
    // Neither the truncated bundle nor the CRL reached the service.
    expect(svc.sent).toHaveLength(4);
  });

  it("reports every result as JSON with --json", async () => {
    const svc = service();
    const root = cert("root-ca");
    await against(svc, ["import", fixturePath(root.der)]);
    const garbage = fixturePath("invalid/garbage.txt");
    const run = await against(svc, [
      "import",
      "--json",
      fixturePath(root.pem),
      garbage,
      fixturePath(cert("issuing-ca-1").der),
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toEqual({
      results: [
        {
          file: fixturePath(root.pem),
          block: 1,
          ok: true,
          outcome: "unchanged",
          id: root.sha256,
          size: readFileSync(fixturePath(root.der)).byteLength,
          importedAt: expect.any(String) as unknown,
          summary: expect.objectContaining({ subjectCN: "Example Root CA (ECC P-384)" }) as unknown,
        },
        {
          file: garbage,
          ok: false,
          error: {
            status: 422,
            code: "invalid_certificate",
            message: "HTTP 422 invalid_certificate (der): Not a valid X.509 certificate",
            details: { reason: "der" },
          },
        },
        expect.objectContaining({ ok: true, outcome: "created", id: cert("issuing-ca-1").sha256 }),
      ],
      created: 1,
      unchanged: 1,
      failed: 1,
    });
  });

  it("reads the token from --token-file or AIA_ADMIN_TOKEN_FILE, trimmed", async () => {
    const svc = service();
    const file = await scratchFile("admin-token", `  ${TOKEN}\r\n\n`);
    const wrong = await scratchFile("wrong-admin-token", "wrong-token\n");
    const root = fixturePath(cert("root-ca").der);
    // The flag wins over a wrong token in either variable.
    const byFlag = await against(svc, ["import", "--token-file", file, root], {
      AIA_URL: BASE,
      AIA_ADMIN_TOKEN: "wrong-token",
    });
    expect(byFlag.code).toBe(0);
    const overFile = await against(svc, ["import", "--token-file", file, root], {
      AIA_URL: BASE,
      AIA_ADMIN_TOKEN_FILE: wrong,
    });
    expect(overFile.code).toBe(0);
    const byEnv = await against(svc, ["import", root], {
      AIA_URL: BASE,
      AIA_ADMIN_TOKEN_FILE: file,
    });
    expect(byEnv.code).toBe(0);
    expect(byEnv.stdout).toMatch(/^unchanged /);
    expect(svc.sent.map((request) => request.headers.get("Authorization"))).toEqual(
      Array.from({ length: 3 }, () => `Bearer ${TOKEN}`)
    );
  });

  it("fails each upload with the service's error on a wrong token", async () => {
    const svc = service();
    const run = await against(svc, ["import", fixturePath(cert("root-ca").der)], {
      AIA_URL: BASE,
      AIA_ADMIN_TOKEN: "wrong-token",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/: HTTP 401 unauthorized: /);
    expect(run.stdout).toBe("0 created, 0 unchanged, 1 failed\n");
  });

  it.each([201, 502])(
    "goes on with the next file when the body of a %i cannot be read",
    async (status) => {
      const svc = service();
      const files = ["root-ca", "issuing-ca-1", "issuing-ca-2"].map((name) =>
        fixturePath(cert(name).der)
      );
      let calls = 0;
      const fetch: CliIo["fetch"] = async (url, init) =>
        calls++ === 0 ? brokenResponse(status) : svc.fetch(url, init);
      const run = await aia(["import", ...files], { env: ENV, fetch });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `failed     ${files[0]}: cannot read the response from ` +
          "https://aia.test/api/v1/admin/certificates: socket reset\n"
      );
      expect(run.stdout.trimEnd().split("\n").at(-1)).toBe("2 created, 0 unchanged, 1 failed");
    }
  );

  it("goes on with the next file when the service cannot be reached", async () => {
    const files = ["root-ca", "issuing-ca-1"].map((name) => fixturePath(cert(name).der));
    const run = await aia(["import", ...files], {
      env: ENV,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(run.code).toBe(1);
    expect(
      run.stderr.match(/cannot reach https:\/\/aia\.test\/api\/v1\/admin\/certificates/g)
    ).toHaveLength(2);
    expect(run.stdout).toBe("0 created, 0 unchanged, 2 failed\n");
  });
});

describe("config validate", () => {
  it("passes docs/config.example.json offline: no URL, no token, no network", async () => {
    const run = await aia(["config", "validate", EXAMPLE]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^.*config\.example\.json: valid offline \(V1-V3/);
    expect(await aia(["config", "validate", "--json", EXAMPLE])).toEqual({
      code: 0,
      stdout: '{\n  "ok": true\n}\n',
      stderr: "",
    });
  });

  it("lists every static violation with its rule and path", async () => {
    const id = cert("root-ca").sha256;
    const target = crypto.randomUUID();
    const twin = crypto.randomUUID();
    const file = await configFile("broken.json", {
      version: 1,
      certificates: { [id]: { label: "Root" } },
      targets: {
        [target]: { issuer: id, kind: "full", label: "Root" },
        [twin]: { issuer: id, kind: "full", label: "Root again" },
      },
      paths: {
        "/ca/root.pem": { certificate: id },
        "/crl/root.crl": { certificate: id },
        "/dcrl/root.crl": { target },
        "/crl/missing.crl": { target: crypto.randomUUID() },
      },
    });
    const run = await aia(["config", "validate", file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe(`${file} is invalid (5 issues):`);
    expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
      '  V2  paths["/ca/root.pem"]',
      '  V3  paths["/crl/root.crl"]',
      '  V3  paths["/dcrl/root.crl"].target',
      '  V4  paths["/crl/missing.crl"].target',
      `  V6  targets["${twin}"]`,
    ]);

    const json = await aia(["config", "validate", "--json", file]);
    expect(json.code).toBe(1);
    const parsed = checkConfigStatic(JSON.parse(await readFile(file, "utf8")));
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, issues: !parsed.ok && parsed.issues });
  });

  it("reports schema (V1) failures such as a misspelled key", async () => {
    const file = await configFile("misspelled.json", {
      version: 1,
      certificates: {},
      tagrets: {},
      paths: {},
    });
    const run = await aia(["config", "validate", file]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^ {2}V1 {2}\(document\): .*tagrets/m);
    expect(run.stderr).toMatch(/^ {2}V1 {2}targets: /m);
  });

  it("exits 1 on a file that is missing or not JSON", async () => {
    const notJson = await scratchFile("not.json", "{ version: 1 }");
    const bad = await aia(["config", "validate", notJson]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^aia: .*not\.json is not JSON: /);
    const missing = await aia(["config", "validate", join(scratch, "nope.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^aia: cannot read .*nope\.json: ENOENT/);
  });
});

describe("config show", () => {
  it("exits 1 while nothing is configured; --json says so as a value", async () => {
    const svc = service();
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "aia: nothing has been configured yet (HTTP 404)\n",
    });
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ etag: null, config: null });
  });

  it("prints the stored bytes, and { etag, config } with --json", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 0,
      stdout: `${MINIMAL_CONFIG}\n`,
      stderr: "",
    });
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      etag: `"${await sha256Hex(new TextEncoder().encode(MINIMAL_CONFIG))}"`,
      config: JSON.parse(MINIMAL_CONFIG) as unknown,
    });
    expect(svc.sent.every((request) => request.method === "GET")).toBe(true);
  });

  it("prints a broken stored config as is, but cannot give it as JSON", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, "{ broken");
    expect((await against(svc, ["config", "show"])).stdout).toBe("{ broken\n");
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json.code).toBe(1);
    expect(json.stderr).toMatch(/the stored config\.json is not JSON/);
  });

  it.each([200, 404, 500])("exits 1 when the body of a %i cannot be read", async (status) => {
    const run = await aia(["config", "show"], {
      env: ENV,
      fetch: async () => brokenResponse(status),
    });
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "aia: cannot read the response from https://aia.test/api/v1/admin/config: socket reset\n",
    });
  });

  it("exits 1 with the service's error", async () => {
    const disabled = service({ settings: { adminToken: undefined } });
    const run = await against(disabled, ["config", "show"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^aia: HTTP 503 admin_disabled: /);
  });
});

describe("config apply", () => {
  it("applies the first config with If-None-Match: *, the next with If-Match", async () => {
    const svc = service();
    await against(svc, ["import", fixturePath(cert("root-ca").der)]);
    const config = configFor(["root-ca"]);
    const file = await configFile("first.json", config);

    const first = await against(svc, ["config", "apply", file]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const stored = await storedConfig(svc);
    const etag = `"${await sha256Hex(stored ?? new Uint8Array())}"`;
    expect(first.stdout).toBe(`applied ${file} (ETag ${etag})\n`);
    const [get, put] = svc.sent.slice(1);
    expect(get).toMatchObject({ method: "GET", url: `${BASE}/api/v1/admin/config` });
    expect(put).toMatchObject({ method: "PUT", url: `${BASE}/api/v1/admin/config` });
    expect(put?.headers.get("If-None-Match")).toBe("*");
    expect(put?.headers.get("If-Match")).toBeNull();
    expect(put?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(put?.body ?? "")).toEqual(config);

    const relabeled = structuredClone(config);
    for (const entry of Object.values(relabeled.certificates)) {
      entry.label = "Example Root CA";
    }
    const second = await against(svc, [
      "config",
      "apply",
      "--json",
      await configFile("second.json", relabeled),
    ]);
    expect(second.code).toBe(0);
    const secondPut = svc.sent.at(-1);
    expect(secondPut?.headers.get("If-Match")).toBe(etag);
    expect(secondPut?.headers.get("If-None-Match")).toBeNull();
    const now = await storedConfig(svc);
    expect(JSON.parse(second.stdout)).toEqual({
      etag: `"${await sha256Hex(now ?? new Uint8Array())}"`,
      config: relabeled,
    });

    expect(await against(svc, ["health"])).toMatchObject({ code: 0 });
  });

  it("sends nothing when the file breaks a static rule", async () => {
    const svc = service();
    const file = await configFile("static.json", { version: 2 });
    const run = await against(svc, ["config", "apply", file]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`^${file} is invalid, nothing was sent \\(`));
    expect(svc.sent).toEqual([]);
  });

  it("prints every issue of a 422 from the service", async () => {
    const svc = service();
    // Statically valid, but nothing is imported (V4).
    const file = await configFile("unimported.json", configFor(["root-ca"]));
    const run = await against(svc, ["config", "apply", file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const id = cert("root-ca").sha256;
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `the service rejected ${file}: HTTP 422 config_invalid: The configuration is invalid ` +
        "(3 issues):",
      `  V4  certificates["${id}"]: Certificate ${id} has not been imported`,
      `  V4  paths["/ca/root-ca.crt"].certificate: Certificate ${id} has not been imported`,
      expect.stringMatching(/^ {2}V4 {2}targets\["[0-9a-f-]{36}"\]\.issuer: Certificate /),
    ]);
    expect(await storedConfig(svc)).toBeUndefined();
  });

  it.each([
    ["GET", 200],
    ["GET", 404],
    ["PUT", 200],
    ["PUT", 422],
  ])("exits 1 when the body of the %s's %i cannot be read", async (method, status) => {
    const svc = service();
    const file = await configFile("broken.json", JSON.parse(MINIMAL_CONFIG));
    const fetch: CliIo["fetch"] = async (url, init) =>
      init.method === method ? brokenResponse(status) : svc.fetch(url, init);
    const run = await aia(["config", "apply", file], { env: ENV, fetch });
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "aia: cannot read the response from https://aia.test/api/v1/admin/config: socket reset\n",
    });
  });

  it("reports 412 when the config changed between GET and PUT, and does not retry", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    // Another operator applies right after this CLI's GET.
    const racing: CliIo["fetch"] = async (url, init) => {
      const res = await svc.fetch(url, init);
      if (init.method === "GET") {
        await putText(svc.deps.store, CONFIG_KEY, `${MINIMAL_CONFIG}\n`);
      }
      return res;
    };
    const file = await configFile("race.json", JSON.parse(MINIMAL_CONFIG));
    const run = await aia(["config", "apply", file], { env: ENV, fetch: racing });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^aia: HTTP 412 precondition_failed: /);
    expect(run.stderr).toMatch(/config\.json changed after it was read .* apply again\n$/);
    expect(svc.sent.map((request) => request.method)).toEqual(["GET", "PUT"]);
  });
});

describe("new-target-id", () => {
  it("prints a fresh lowercase RFC 9562 UUID, offline", async () => {
    const one = await aia(["new-target-id"]);
    const two = await aia(["new-target-id"]);
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/^[0-9a-f-]{36}\n$/);
    expect(TargetId.safeParse(one.stdout.trim()).success).toBe(true);
    expect(two.stdout).not.toBe(one.stdout);
    const json = await aia(["new-target-id", "--json"]);
    expect(TargetId.safeParse((JSON.parse(json.stdout) as { id: unknown }).id).success).toBe(true);
  });
});

describe("publish", () => {
  const ROOT_01 = fixturePath("crls/root-ca/full-01.der");
  const FULL_01 = fixturePath("crls/issuing-ca-1/full-01.der");
  const FULL_01_PEM = fixturePath("crls/issuing-ca-1/full-01.pem");
  const FULL_02 = fixturePath("crls/issuing-ca-1/full-02.der");
  const UPLOAD_ENV = { AIA_URL: BASE };

  /** The service with every certificate imported and the shared targets applied. */
  async function publishing(overrides: TestOverrides = {}) {
    const svc = service(overrides);
    const setup = await setupPublish(svc.deps.store);
    return { svc, setup };
  }

  function entry(path: string) {
    const file = path.slice(fixturePath("").length);
    const found = manifest.crls.find((crl) => crl.file === file);
    if (found === undefined) {
      throw new Error(`no manifest CRL ${file}`);
    }
    return found;
  }

  it("sends DER as application/pkix-crl and PEM as application/x-pem-file, no token unless set", async () => {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", ROOT_01, FULL_01_PEM], {
      ...UPLOAD_ENV,
      // The admin token is never sent to the upload route.
      AIA_ADMIN_TOKEN: TOKEN,
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      `created    ${setup.target("root-ca", "full")}  full #${entry(ROOT_01).crlNumber}  ` +
        `${ROOT_01}\n` +
        `created    ${setup.target("issuing-ca-1", "full")}  full #${entry(FULL_01).crlNumber}  ` +
        `${FULL_01_PEM}\n` +
        "2 created, 0 updated, 0 unchanged, 0 failed\n"
    );
    expect(svc.sent.map((request) => [request.method, request.url])).toEqual([
      ["POST", `${BASE}/api/v1/crls`],
      ["POST", `${BASE}/api/v1/crls`],
    ]);
    expect(svc.sent.map((request) => request.headers.get("Content-Type"))).toEqual([
      "application/pkix-crl",
      "application/x-pem-file",
    ]);
    // Each file as is, byte for byte.
    expect(svc.sent.map((request) => request.bytes)).toEqual(
      [ROOT_01, FULL_01_PEM].map((file) => new Uint8Array(readFileSync(file)))
    );
    expect(svc.sent.every((request) => request.headers.get("Authorization") === null)).toBe(true);
  });

  it("sends a PEM bundle as is, for the service to refuse with pem_blocks", async () => {
    const { svc } = await publishing();
    const bundled = text("crls/issuing-ca-1/full-01.pem") + text("crls/root-ca/full-01.pem");
    const bundle = await scratchFile("bundle.pem", bundled);
    const run = await against(svc, ["publish", bundle], UPLOAD_ENV);
    expect(run).toEqual({
      code: 1,
      stdout: "0 created, 0 updated, 0 unchanged, 1 failed\n",
      stderr: `failed     ${bundle}: HTTP 422 invalid_crl (pem_blocks): Not a valid X.509 CRL\n`,
    });
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]?.headers.get("Content-Type")).toBe("application/x-pem-file");
    expect(svc.sent[0]?.bytes).toEqual(new TextEncoder().encode(bundled));
  });

  it("publishes each file on its own: updated, unchanged and failures, exit 1", async () => {
    const { svc, setup } = await publishing();
    expect((await against(svc, ["publish", FULL_01], UPLOAD_ENV)).code).toBe(0);
    const missing = join(scratch, "missing.crl");
    const garbage = fixturePath("invalid/garbage.txt");
    const delta = fixturePath("crls/issuing-ca-1/delta-01.der");
    const run = await against(
      svc,
      ["publish", FULL_02, FULL_01, missing, garbage, FULL_02, delta],
      UPLOAD_ENV
    );
    expect(run.code).toBe(1);
    const full = setup.target("issuing-ca-1", "full");
    const number = entry(FULL_02).crlNumber;
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      `updated    ${full}  full #${number}  ${FULL_02}`,
      `unchanged  ${full}  full #${number}  ${FULL_02}`,
      `created    ${setup.target("issuing-ca-1", "delta")}  delta #${entry(delta).crlNumber}  ${delta}`,
      "1 created, 1 updated, 1 unchanged, 3 failed",
    ]);
    const thisUpdate = new Date(entry(FULL_02).thisUpdate).toISOString();
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${FULL_01}: HTTP 409 stale_crl: The CRL is older than the target's current CRL ` +
        `(current: CRL Number ${number}, thisUpdate ${thisUpdate})`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${garbage}: HTTP 422 invalid_crl (der): Not a valid X.509 CRL`,
    ]);
    // The missing file was never sent.
    expect(svc.sent).toHaveLength(6);
  });

  it("prints the details of other failures", async () => {
    const { svc } = await publishing();
    const ed25519 = fixturePath("crls/ed25519-ca/full-01.der");
    const run = await against(svc, ["publish", ed25519], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(
      /: HTTP 422 unsupported_algorithm: The CRL's signature algorithm is not supported \(algorithm Ed25519\)\n$/
    );
    expect(run.stdout).toBe("0 created, 0 updated, 0 unchanged, 1 failed\n");
  });

  it("reports every result as JSON with --json", async () => {
    const { svc, setup } = await publishing();
    const garbage = fixturePath("invalid/garbage.txt");
    const run = await against(svc, ["publish", "--json", ROOT_01, garbage], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    const root = entry(ROOT_01);
    expect(JSON.parse(run.stdout)).toEqual({
      results: [
        {
          file: ROOT_01,
          ok: true,
          outcome: "created",
          target: setup.target("root-ca", "full"),
          kind: "full",
          sha256: root.sha256,
          crlNumber: root.crlNumber,
          baseCrlNumber: null,
          thisUpdate: new Date(root.thisUpdate).toISOString(),
          nextUpdate: new Date(root.nextUpdate ?? "").toISOString(),
          issuer: cert("root-ca").sha256,
          downloads: ["/crl/root-ca.crl", "/crl/root-ca.crl.pem"],
        },
        {
          file: garbage,
          ok: false,
          error: {
            status: 422,
            code: "invalid_crl",
            message: "HTTP 422 invalid_crl (der): Not a valid X.509 CRL",
            details: { reason: "der" },
          },
        },
      ],
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 1,
    });
  });

  it("sends the upload token from AIA_UPLOAD_TOKEN, AIA_UPLOAD_TOKEN_FILE or --token-file", async () => {
    const { svc } = await publishing({ settings: { uploadToken: UPLOAD_TOKEN } });
    const file = await scratchFile("upload-token", `  ${UPLOAD_TOKEN}\r\n`);
    const byEnv = await against(svc, ["publish", ROOT_01], {
      ...UPLOAD_ENV,
      AIA_UPLOAD_TOKEN: UPLOAD_TOKEN,
    });
    expect(byEnv.code).toBe(0);
    const byFile = await against(svc, ["publish", ROOT_01], {
      ...UPLOAD_ENV,
      AIA_UPLOAD_TOKEN_FILE: file,
    });
    expect(byFile.stdout).toMatch(/^unchanged /);
    // The flag wins over a wrong token in either variable.
    const byFlag = await against(svc, ["publish", "--token-file", file, ROOT_01], {
      ...UPLOAD_ENV,
      AIA_UPLOAD_TOKEN: "wrong-token",
    });
    expect(byFlag.code).toBe(0);
    const wrong = await scratchFile("wrong-upload-token", "wrong-token\n");
    const overFile = await against(svc, ["publish", "--token-file", file, ROOT_01], {
      ...UPLOAD_ENV,
      AIA_UPLOAD_TOKEN_FILE: wrong,
    });
    expect(overFile.code).toBe(0);
    expect(svc.sent.map((request) => request.headers.get("Authorization"))).toEqual(
      Array.from({ length: 4 }, () => `Bearer ${UPLOAD_TOKEN}`)
    );
  });

  it("fails each file with the service's 401 without the token it needs", async () => {
    const { svc } = await publishing({ settings: { uploadToken: UPLOAD_TOKEN } });
    const run = await against(svc, ["publish", ROOT_01, FULL_01], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr.match(/: HTTP 401 unauthorized: Unauthorized\n/g)).toHaveLength(2);
    expect(run.stdout).toBe("0 created, 0 updated, 0 unchanged, 2 failed\n");
  });

  it("refuses both token variables, an empty or a malformed upload token, before sending", async () => {
    const empty = await scratchFile("empty-upload-token", "\n");
    const both = await scratchFile("both-upload-token", `${UPLOAD_TOKEN}\n`);
    const cases: [Record<string, string>, RegExp][] = [
      [
        { AIA_UPLOAD_TOKEN: UPLOAD_TOKEN, AIA_UPLOAD_TOKEN_FILE: both },
        /set either AIA_UPLOAD_TOKEN or AIA_UPLOAD_TOKEN_FILE, not both/,
      ],
      [{ AIA_UPLOAD_TOKEN_FILE: empty }, /the upload token in the token file .* is empty/],
      [{ AIA_UPLOAD_TOKEN: "" }, /the upload token in AIA_UPLOAD_TOKEN is empty/],
      [{ AIA_UPLOAD_TOKEN: `${UPLOAD_TOKEN} $x` }, /upload token .* has characters a bearer/],
      [{ AIA_UPLOAD_TOKEN_FILE: join(scratch, "no-such-token") }, /cannot read the token file/],
    ];
    for (const [env, message] of cases) {
      const run = await aia(["publish", ROOT_01], { env: { ...UPLOAD_ENV, ...env } });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(message);
    }
  });

  it("goes on with the next file when the service cannot be reached", async () => {
    const run = await aia(["publish", ROOT_01, FULL_01], {
      env: UPLOAD_ENV,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(run.code).toBe(1);
    expect(
      run.stderr.match(/cannot reach https:\/\/aia\.test\/api\/v1\/crls: fetch failed/g)
    ).toHaveLength(2);
    expect(run.stdout).toBe("0 created, 0 updated, 0 unchanged, 2 failed\n");
  });

  it.each<[string, () => Response, RegExp]>([
    [
      "a proxy's error page",
      () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      /: HTTP 502: Bad Gateway\n$/,
    ],
    [
      "a 201 that is not JSON",
      () => new Response("<html>ok</html>", { status: 201 }),
      /: HTTP 201, but the body is not JSON\n$/,
    ],
    [
      "JSON that is not an upload result",
      () => Response.json({ status: "healthy" }),
      /: HTTP 200, but the body is not an upload result\n$/,
    ],
    ["a body that cannot be read", () => brokenResponse(201), /: cannot read the response from /],
  ])("fails a file on %s", async (_, response, message) => {
    const run = await aia(["publish", ROOT_01], { env: UPLOAD_ENV, fetch: async () => response() });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(run.stdout).toBe("0 created, 0 updated, 0 unchanged, 1 failed\n");
  });
});
