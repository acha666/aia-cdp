// The CLI in process: main() with fetch = app.request over a MemoryStore, so every subcommand's
// output and exit code is checked without a socket. tests/integration/node-e2e.test.ts runs it as
// a real process against the Node runtime.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, USAGE } from "../../src/cli/aia.ts";
import type { CliIo } from "../../src/cli/aia.ts";
import { CONFIG_KEY, TargetId } from "../../src/core/catalog.ts";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { createApp } from "../../src/http/app.ts";
import { fixturePath } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { cert, crlEntry } from "../helpers/catalog.ts";
import { setupPublish } from "../helpers/publish.ts";

const TOKEN = "cli-s3cret-token";
const UPLOAD_TOKEN = "cli-upload-s3cret";
const BASE = "https://aia.test";
const ENV = { AIA_URL: BASE, AIA_ADMIN_TOKEN: TOKEN };
const EXAMPLE = fileURLToPath(new URL("../../docs/config.example.json", import.meta.url));
const ROOT_DER = fixturePath(cert("root-ca").der);
const ROOT_CRL = fixturePath("crls/root-ca/full-01.der");
const GARBAGE = fixturePath("invalid/garbage.txt");

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

interface Sent {
  method: string;
  url: string;
  headers: Headers;
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
      bytes: new Uint8Array(await request.clone().arrayBuffer()),
    });
    return app.request(request);
  };
  const authorization = () => sent.map((request) => request.headers.get("Authorization"));
  return { deps, fetch, sent, authorization };
}

type Service = ReturnType<typeof service>;

/** A fetch that must not be called. */
const offline: CliIo["fetch"] = () => {
  throw new Error("this command must not touch the network");
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function aia(argv: string[], io: Partial<Pick<CliIo, "fetch" | "env">> = {}): Promise<Run> {
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
    readFile: (path) => readFile(path),
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

async function storedEtag(svc: Service): Promise<string> {
  const stored = await svc.deps.store.get(CONFIG_KEY);
  return `"${await sha256Hex(stored?.bytes ?? new Uint8Array())}"`;
}

describe("usage", () => {
  it("prints the usage on stdout with --help and exits 0", async () => {
    expect(await aia(["--help"])).toEqual({ code: 0, stdout: USAGE, stderr: "" });
  });

  it.each([
    [[], /missing command/],
    [["frobnicate"], /unknown command "frobnicate"/],
    [["import"], /import needs at least one file/],
    [["config", "edit"], /unknown config command "edit"/],
    [["health", "--nope"], /Unknown option '--nope'/],
  ])("%j → exit 2", async (argv, message) => {
    const run = await aia(argv, { env: ENV });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toMatch(/Run "aia --help" for usage\.\n$/);
  });

  it("needs a service URL, and an admin token for the admin commands", async () => {
    const noUrl = await aia(["health"], { env: { AIA_ADMIN_TOKEN: TOKEN } });
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toMatch(/no service URL: pass --url or set AIA_URL/);
    const noToken = await aia(["import", ROOT_DER], { env: { AIA_URL: BASE } });
    expect(noToken.code).toBe(2);
    expect(noToken.stderr).toMatch(/no admin token: pass --token-file/);
  });
});

describe("tokens", () => {
  // The production host answers plain HTTP (AIA / CDP clients need it), so http://<host> reaches
  // the service and would carry a token in clear text.
  it("sends a token over plain http:// only to a loopback host or with --allow-insecure-http", async () => {
    const svc = service({ settings: { uploadToken: UPLOAD_TOKEN } });
    await setupPublish(svc.deps.store);
    const at = (url: string, argv: string[]) =>
      aia(argv, {
        fetch: svc.fetch,
        env: { AIA_URL: url, AIA_ADMIN_TOKEN: TOKEN, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
      });
    for (const [name, argv] of [
      ["admin", ["import", ROOT_DER]],
      ["upload", ["publish", ROOT_CRL]],
    ] as const) {
      expect(await at("http://pki.example:8080/aia", [...argv])).toEqual({
        code: 2,
        stdout: "",
        stderr:
          `aia: refusing to send the ${name} token over http:// to pki.example:8080: use ` +
          'https://, or pass --allow-insecure-http\nRun "aia --help" for usage.\n',
      });
    }
    expect(svc.sent).toEqual([]);

    const runs = [
      await at("http://localhost:8787", ["import", ROOT_DER]),
      await at("http://127.0.0.1:8787", ["publish", ROOT_CRL]),
      await at("http://pki.example", ["publish", "--allow-insecure-http", ROOT_CRL]),
    ];
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0]);
    expect(svc.authorization()).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${UPLOAD_TOKEN}`,
      `Bearer ${UPLOAD_TOKEN}`,
    ]);
  });

  it("checks nothing without a token: health, and publish to a service that needs none", async () => {
    const svc = service();
    await setupPublish(svc.deps.store);
    const env = { AIA_URL: "http://aia.test" };
    expect((await aia(["health"], { fetch: svc.fetch, env })).stderr).toBe("");
    expect((await aia(["publish", ROOT_CRL], { fetch: svc.fetch, env })).code).toBe(0);
    expect(svc.authorization()).toEqual([null, null]);
  });

  it("reads a token from --token-file, which wins over the variables, or <NAME>_FILE, trimmed", async () => {
    const svc = service({ settings: { uploadToken: UPLOAD_TOKEN } });
    await setupPublish(svc.deps.store);
    const admin = await scratchFile("admin-token", `  ${TOKEN}\r\n\n`);
    const upload = await scratchFile("upload-token", `${UPLOAD_TOKEN}\n`);
    const runs = [
      await against(svc, ["import", "--token-file", admin, ROOT_DER], {
        AIA_URL: BASE,
        AIA_ADMIN_TOKEN: "wrong-token",
      }),
      await against(svc, ["publish", ROOT_CRL], { AIA_URL: BASE, AIA_UPLOAD_TOKEN_FILE: upload }),
    ];
    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    expect(svc.authorization()).toEqual([`Bearer ${TOKEN}`, `Bearer ${UPLOAD_TOKEN}`]);
  });

  it("refuses both token variables or a malformed token before sending: exit 2", async () => {
    const file = await scratchFile("both-token", `${TOKEN}\n`);
    const cases: [string[], Record<string, string>, RegExp][] = [
      [
        ["config", "show"],
        { AIA_ADMIN_TOKEN: TOKEN, AIA_ADMIN_TOKEN_FILE: file },
        /set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE, not both/,
      ],
      [
        ["publish", ROOT_CRL],
        { AIA_UPLOAD_TOKEN: `${UPLOAD_TOKEN}\nX-Injected: 1` },
        /upload token .* has characters a bearer token cannot have/,
      ],
    ];
    for (const [argv, env, message] of cases) {
      const run = await aia(argv, { env: { AIA_URL: BASE, ...env } });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(message);
    }
  });
});

describe("health", () => {
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
});

describe("import", () => {
  it("sends a DER file as application/pkix-cert, then its PEM is unchanged", async () => {
    const svc = service();
    const root = cert("root-ca");
    expect(await against(svc, ["import", ROOT_DER])).toEqual({
      code: 0,
      stdout:
        `created    ${root.sha256}  Example Root CA (ECC P-384)  ${ROOT_DER}\n` +
        "1 created, 0 unchanged, 0 failed\n",
      stderr: "",
    });
    const unchanged = await against(svc, ["import", fixturePath(root.pem)]);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toMatch(new RegExp(`^unchanged  ${root.sha256}  `));
    expect(svc.sent.map((request) => request.headers.get("Content-Type"))).toEqual([
      "application/pkix-cert",
      "application/x-pem-file",
    ]);
    expect(svc.authorization()).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("sends each certificate block on its own, isolates failures, and exits 1", async () => {
    const svc = service();
    const badBlock = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n";
    // Other labels (a key) are skipped and never sent; text around the blocks is ignored.
    const key =
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n";
    const issuing = readFileSync(fixturePath(cert("issuing-ca-1").pem), "utf8");
    const mixed = await scratchFile("mixed.pem", `Chain\n${badBlock}${key}${issuing}`);
    const missing = join(scratch, "missing.der");
    const crlPem = fixturePath("crls/root-ca/full-01.pem");

    const run = await against(svc, ["import", GARBAGE, missing, mixed, crlPem, ROOT_DER]);
    expect(run.code).toBe(1);
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${GARBAGE}: HTTP 422 invalid_certificate (der): Not a valid X.509 certificate`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${mixed} [block 1/2]: HTTP 422 invalid_certificate (pem_base64): ` +
        "Not a valid X.509 certificate",
      `failed     ${crlPem}: no CERTIFICATE PEM block`,
    ]);
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(
        new RegExp(`^created    ${cert("issuing-ca-1").sha256}  .*  ${mixed} \\[block 2/2\\]$`)
      ),
      expect.stringMatching(new RegExp(`^created    ${cert("root-ca").sha256}  `)),
      "2 created, 0 unchanged, 4 failed",
    ]);
    // Only the certificate blocks went out, one per request.
    const pems = svc.sent
      .filter((request) => request.headers.get("Content-Type") === "application/x-pem-file")
      .map((request) => new TextDecoder().decode(request.bytes));
    expect(pems).toEqual([badBlock, issuing]);
  });
});

describe("config validate", () => {
  it("passes docs/config.example.json offline: no URL, no token, no network", async () => {
    const run = await aia(["config", "validate", EXAMPLE]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^.*config\.example\.json: valid offline \(V1-V3/);
  });

  it("lists every static violation with its rule and path, and exits 1", async () => {
    const id = cert("root-ca").sha256;
    const file = await configFile("broken.json", {
      version: 1,
      certificates: { [id]: { label: "Root" } },
      targets: {},
      paths: {
        "/ca/root.pem": { certificate: id },
        "/crl/missing.crl": { target: crypto.randomUUID() },
      },
    });
    const run = await aia(["config", "validate", file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe(`${file} is invalid (2 issues):`);
    expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
      '  V2  paths["/ca/root.pem"]',
      '  V4  paths["/crl/missing.crl"].target',
    ]);
  });
});

describe("config show", () => {
  it("exits 1 while nothing is configured, then prints the stored bytes, or { etag, config }", async () => {
    const svc = service();
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "aia: nothing has been configured yet (HTTP 404)\n",
    });
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 0,
      stdout: `${MINIMAL_CONFIG}\n`,
      stderr: "",
    });
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      etag: await storedEtag(svc),
      config: JSON.parse(MINIMAL_CONFIG) as unknown,
    });
  });
});

describe("config apply", () => {
  it("applies the first config with If-None-Match: *, the next with If-Match", async () => {
    const svc = service();
    await against(svc, ["import", ROOT_DER]);
    const config = configFor(["root-ca"]);
    const file = await configFile("first.json", config);

    const first = await against(svc, ["config", "apply", file]);
    expect(first.code).toBe(0);
    const etag = await storedEtag(svc);
    expect(first.stdout).toBe(`applied ${file} (ETag ${etag})\n`);
    const [get, put] = svc.sent.slice(1);
    expect(get).toMatchObject({ method: "GET", url: `${BASE}/api/v1/admin/config` });
    expect(put).toMatchObject({ method: "PUT", url: `${BASE}/api/v1/admin/config` });
    expect(put?.headers.get("If-None-Match")).toBe("*");
    expect(put?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(put?.bytes))).toEqual(config);

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
    expect(svc.sent.at(-1)?.headers.get("If-Match")).toBe(etag);
    expect(JSON.parse(second.stdout)).toEqual({ etag: await storedEtag(svc), config: relabeled });
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
  it("prints a fresh target id, offline", async () => {
    const one = await aia(["new-target-id"]);
    const two = await aia(["new-target-id"]);
    expect(one.code).toBe(0);
    expect(TargetId.safeParse(one.stdout.replace(/\n$/, "")).success).toBe(true);
    expect(two.stdout).not.toBe(one.stdout);
  });
});

describe("publish", () => {
  const FULL_01 = "crls/issuing-ca-1/full-01.der";
  const FULL_01_PEM = fixturePath("crls/issuing-ca-1/full-01.pem");
  const FULL_02 = "crls/issuing-ca-1/full-02.der";
  const UPLOAD_ENV = { AIA_URL: BASE };

  /** The service with every certificate imported and the shared targets applied. */
  async function publishing(overrides: TestOverrides = {}) {
    const svc = service(overrides);
    const setup = await setupPublish(svc.deps.store);
    return { svc, setup };
  }

  it("sends DER as application/pkix-crl and PEM as application/x-pem-file, no token unless set", async () => {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", ROOT_CRL, FULL_01_PEM], {
      ...UPLOAD_ENV,
      // The admin token is never sent to the upload route.
      AIA_ADMIN_TOKEN: TOKEN,
    });
    expect(run).toEqual({
      code: 0,
      stdout:
        `created    ${setup.target("root-ca", "full")}  ` +
        `full #${crlEntry("crls/root-ca/full-01.der").crlNumber}  ${ROOT_CRL}\n` +
        `created    ${setup.target("issuing-ca-1", "full")}  ` +
        `full #${crlEntry(FULL_01).crlNumber}  ${FULL_01_PEM}\n` +
        "2 created, 0 updated, 0 unchanged, 0 failed\n",
      stderr: "",
    });
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
      [ROOT_CRL, FULL_01_PEM].map((file) => new Uint8Array(readFileSync(file)))
    );
    expect(svc.authorization()).toEqual([null, null]);
  });

  it("publishes each file on its own: updated, unchanged and failures, exit 1", async () => {
    const { svc, setup } = await publishing();
    expect((await against(svc, ["publish", fixturePath(FULL_01)], UPLOAD_ENV)).code).toBe(0);
    const missing = join(scratch, "missing.crl");
    const full01 = fixturePath(FULL_01);
    const full02 = fixturePath(FULL_02);
    const run = await against(
      svc,
      ["publish", full02, full01, missing, GARBAGE, full02],
      UPLOAD_ENV
    );
    expect(run.code).toBe(1);
    const full = setup.target("issuing-ca-1", "full");
    const number = crlEntry(FULL_02).crlNumber;
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      `updated    ${full}  full #${number}  ${full02}`,
      `unchanged  ${full}  full #${number}  ${full02}`,
      "0 created, 1 updated, 1 unchanged, 3 failed",
    ]);
    const thisUpdate = new Date(crlEntry(FULL_02).thisUpdate).toISOString();
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${full01}: HTTP 409 stale_crl: The CRL is older than the target's current CRL ` +
        `(current: CRL Number ${number}, thisUpdate ${thisUpdate})`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${GARBAGE}: HTTP 422 invalid_crl (der): Not a valid X.509 CRL`,
    ]);
    // The missing file was never sent.
    expect(svc.sent).toHaveLength(5);
  });

  it("reports every result as JSON with --json", async () => {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", "--json", ROOT_CRL, GARBAGE], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    const root = crlEntry("crls/root-ca/full-01.der");
    expect(JSON.parse(run.stdout)).toEqual({
      results: [
        {
          file: ROOT_CRL,
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
          file: GARBAGE,
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

  it("fails each file with the service's 401 without the token it needs", async () => {
    const { svc } = await publishing({ settings: { uploadToken: UPLOAD_TOKEN } });
    const run = await against(svc, ["publish", ROOT_CRL, FULL_01_PEM], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr.match(/: HTTP 401 unauthorized: Unauthorized\n/g)).toHaveLength(2);
    expect(run.stdout).toBe("0 created, 0 updated, 0 unchanged, 2 failed\n");
  });
});
