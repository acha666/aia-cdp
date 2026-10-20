// aia: the command-line client of the admin API (plan §7.4, implementation slice 2 step 9). A
// thin HTTP client on node:util parseArgs and fetch, with no dependencies of its own. From the core
// it shares isDerSequence / splitPemBlocks (the API takes one certificate per request, so a PEM
// bundle goes block by block) and the static config rules (`config validate` runs offline).
//
//   node src/cli/aia.ts <command> …          (pnpm aia …; Node runs the source)
//   node dist/server/cli/aia.js <command> …  (the Docker image)
//
// main(argv, io) does all I/O through `io`, so tests inject fetch = app.request. Exit codes: 0
// success, 1 the operation failed (or the service is not healthy), 2 usage error. The admin token
// is never printed.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { checkConfigStatic } from "../core/admin.ts";
import type { ConfigIssue } from "../core/admin.ts";
import { decodeJson } from "../core/catalog.ts";
import { isDerSequence, splitPemBlocks } from "../core/pki/pem.ts";

export interface CliIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Readonly<Record<string, string | undefined>>;
  /** Each call receives finished text, newlines included. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
}

export const USAGE = `Usage: aia [options] <command>

Commands:
  import <file...>        Import CA certificates: DER, or PEM with one or more blocks
                          (each block is imported on its own)
  config show             Print the stored config.json
  config validate <file>  Check a configuration offline: rules V1-V3 and the static parts of
                          V4 / V6; the rest (V4-V9) needs the service and is checked on apply
  config apply <file>     Validate, then replace config.json (If-Match: the ETag of a fresh GET;
                          If-None-Match: * for the first configuration)
  new-target-id           Print a new target id (a random UUID)
  health                  Exit 0 only if the service reports healthy

Options:
  --url <url>             Service base URL (default: $AIA_URL)
  --token-file <file>     File holding the admin token (default: $AIA_ADMIN_TOKEN_FILE,
                          else the token in $AIA_ADMIN_TOKEN)
  --json                  Print results as JSON on stdout (errors stay text on stderr)
  -h, --help              Show this help

Exit codes: 0 success, 1 failure or not healthy, 2 usage error.
`;

const OPTIONS = {
  url: { type: "string" },
  "token-file": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Wrong arguments or settings: exit 2. */
class UsageError extends Error {
  override name = "UsageError";
}

/** The operation failed; the message is printed as is: exit 1. */
class Failure extends Error {
  override name = "Failure";
}

interface Context {
  io: CliIo;
  json: boolean;
  /** --url, else AIA_URL. */
  url: string | undefined;
  /** --token-file, else AIA_ADMIN_TOKEN_FILE. */
  tokenFile: string | undefined;
  /** Whether --token-file was given (it then wins over both variables). */
  tokenFileFlag: boolean;
}

/** Runs one command line (without `node` and the script). Resolves to the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: OPTIONS,
        strict: true,
        allowPositionals: true,
      });
    } catch (error) {
      throw new UsageError(reasonOf(error));
    }
    const { values, positionals } = parsed;
    if (values.help === true || positionals[0] === "help") {
      io.stdout(USAGE);
      return 0;
    }
    const tokenFile = values["token-file"];
    const ctx: Context = {
      io,
      json: values.json === true,
      url: values.url ?? io.env.AIA_URL,
      tokenFile: tokenFile ?? io.env.AIA_ADMIN_TOKEN_FILE,
      tokenFileFlag: tokenFile !== undefined,
    };
    return await run(ctx, positionals);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`aia: ${error.message}\nRun "aia --help" for usage.\n`);
      return 2;
    }
    if (error instanceof Failure) {
      io.stderr(`aia: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function run(ctx: Context, positionals: string[]): Promise<number> {
  const [command, ...args] = positionals;
  switch (command) {
    case undefined:
      throw new UsageError("missing command");
    case "import":
      if (args.length === 0) {
        throw new UsageError("import needs at least one file");
      }
      return importFiles(ctx, args);
    case "config": {
      const [sub, ...rest] = args;
      switch (sub) {
        case "show":
          expectArgs(rest, 0, "config show");
          return configShow(ctx);
        case "validate":
          expectArgs(rest, 1, "config validate <file>");
          return configValidate(ctx, rest[0] ?? "");
        case "apply":
          expectArgs(rest, 1, "config apply <file>");
          return configApply(ctx, rest[0] ?? "");
        case undefined:
          throw new UsageError("config needs show, validate or apply");
        default:
          throw new UsageError(`unknown config command ${JSON.stringify(sub)}`);
      }
    }
    case "new-target-id":
      expectArgs(args, 0, "new-target-id");
      return newTargetId(ctx);
    case "health":
      expectArgs(args, 0, "health");
      return health(ctx);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

function expectArgs(args: string[], count: number, form: string): void {
  if (args.length !== count) {
    throw new UsageError(`usage: aia ${form}`);
  }
}

// Output -----------------------------------------------------------------------------------------

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  // fetch rejects with "fetch failed" and the socket error as its cause.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

// Field names print dotted; map keys (ids, paths) bracketed: paths["/ca/root.crt"].certificate.
function pathText(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "(document)";
  }
  return path
    .map((key, index) => {
      if (typeof key === "string" && /^[A-Za-z]+$/.test(key)) {
        return index === 0 ? key : `.${key}`;
      }
      return `[${JSON.stringify(key)}]`;
    })
    .join("");
}

function issuesText(title: string, issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  ${issue.rule}  ${pathText(issue.path)}: ${issue.message}`);
  const count = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
  return `${title} (${count}):\n${lines.join("\n")}\n`;
}

// Service access ---------------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// RFC 6750 b64token, as the service requires of AIA_ADMIN_TOKEN (src/runtime/settings.ts). Checked
// here as well, because fetch rejects an invalid header value with a message that quotes it.
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

/** The base URL without a trailing slash; a path prefix (behind a proxy) is kept. */
function serviceUrl(ctx: Context): string {
  if (ctx.url === undefined || ctx.url === "") {
    throw new UsageError("no service URL: pass --url or set AIA_URL");
  }
  let url: URL;
  try {
    url = new URL(ctx.url);
  } catch {
    throw new UsageError("--url / AIA_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--url / AIA_URL must be an http:// or https:// URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** `Authorization` (and `Accept`) for the admin routes. Messages name the source, never the token. */
async function adminHeaders(ctx: Context): Promise<Record<string, string>> {
  const { env } = ctx.io;
  let token: string | undefined;
  let source: string;
  if (ctx.tokenFile !== undefined && ctx.tokenFile !== "") {
    if (!ctx.tokenFileFlag && env.AIA_ADMIN_TOKEN !== undefined) {
      throw new UsageError("set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE, not both");
    }
    source = `the token file ${ctx.tokenFile}`;
    try {
      token = new TextDecoder().decode(await ctx.io.readFile(ctx.tokenFile)).trim();
    } catch (error) {
      throw new UsageError(`cannot read ${source}: ${reasonOf(error)}`);
    }
  } else {
    source = "AIA_ADMIN_TOKEN";
    token = env.AIA_ADMIN_TOKEN?.trim();
  }
  if (token === undefined) {
    throw new UsageError(
      "no admin token: pass --token-file, or set AIA_ADMIN_TOKEN_FILE or AIA_ADMIN_TOKEN"
    );
  }
  if (token === "") {
    throw new UsageError(`the admin token in ${source} is empty`);
  }
  if (!BEARER_TOKEN.test(token)) {
    throw new UsageError(
      `the admin token in ${source} has characters a bearer token cannot have ` +
        "(letters, digits and - . _ ~ + / only, optionally ending in =)"
    );
  }
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** fetch with a timeout; a request that gets no response at all is a Failure. */
async function send(ctx: Context, url: string, init: RequestInit): Promise<Response> {
  try {
    return await ctx.io.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Failure(`cannot reach ${url}: ${reasonOf(error)}`);
  }
}

/** A non-success response: the error envelope's fields, or the status line without one. */
interface HttpError {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
}

async function httpError(res: Response): Promise<HttpError> {
  const text = await res.text();
  try {
    const { error } = JSON.parse(text) as { error?: Record<string, unknown> };
    if (typeof error?.code === "string" && typeof error.message === "string") {
      return {
        status: res.status,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
  } catch {
    // Not an envelope (a proxy's page, say): fall through.
  }
  return { status: res.status, message: res.statusText || "unexpected response" };
}

function describeHttp(error: HttpError): string {
  const details = error.details as { reason?: unknown } | undefined;
  const reason = typeof details?.reason === "string" ? ` (${details.reason})` : "";
  const code = error.code === undefined ? "" : ` ${error.code}`;
  return `HTTP ${error.status}${code}${reason}: ${error.message}`;
}

/** The JSON body of a success response; a body that is not JSON is a Failure. */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new Failure(`HTTP ${res.status}, but the body is not JSON`);
  }
}

function isConfigIssues(value: unknown): value is ConfigIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue: Partial<Record<keyof ConfigIssue, unknown>>) =>
        Array.isArray(issue.path) &&
        typeof issue.rule === "string" &&
        typeof issue.message === "string"
    )
  );
}

// import -----------------------------------------------------------------------------------------

/** What one POST sends: a whole DER file, or one block of a PEM file. */
interface Upload {
  file: string;
  /** 1-based block number within a PEM file, and the file's block count. */
  block?: { index: number; count: number };
  contentType: string;
  body: Uint8Array | string;
}

interface Imported {
  outcome: "created" | "unchanged";
  id: string;
  summary: { subjectCN: string | null };
}

/** One line of the import report (`--json`: the array `results`). */
type ImportResult = { file: string; block?: number } & (
  | ({ ok: true } & Imported & Record<string, unknown>)
  | { ok: false; error: { message: string } & Partial<HttpError> }
);

function sourceOf(upload: Pick<Upload, "file" | "block">): string {
  const { block } = upload;
  return block === undefined || block.count === 1
    ? upload.file
    : `${upload.file} [block ${block.index}/${block.count}]`;
}

/**
 * The uploads of one file, recognized from the bytes as the service does (toDer): one DER
 * SEQUENCE is sent as is; text with PEM boundaries is split into its CERTIFICATE blocks (other
 * labels, such as a key, are skipped and never sent); anything else is sent as is for the service
 * to report.
 */
async function uploadsOf(io: CliIo, file: string): Promise<Upload[]> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(file);
  } catch (error) {
    throw new Failure(`cannot read the file: ${reasonOf(error)}`);
  }
  if (isDerSequence(bytes)) {
    return [{ file, contentType: "application/pkix-cert", body: bytes }];
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.includes("-----BEGIN ")) {
    return [{ file, contentType: "application/pkix-cert", body: bytes }];
  }
  let blocks: string[];
  try {
    blocks = splitPemBlocks(text, "certificate");
  } catch (error) {
    throw new Failure(reasonOf(error));
  }
  if (blocks.length === 0) {
    throw new Failure("no CERTIFICATE PEM block");
  }
  return blocks.map((body, index) => ({
    file,
    block: { index: index + 1, count: blocks.length },
    contentType: "application/x-pem-file",
    body,
  }));
}

async function importOne(
  ctx: Context,
  url: string,
  headers: Record<string, string>,
  upload: Upload
): Promise<ImportResult> {
  const where = {
    file: upload.file,
    ...(upload.block === undefined ? {} : { block: upload.block.index }),
  };
  try {
    const res = await send(ctx, url, {
      method: "POST",
      headers: { ...headers, "Content-Type": upload.contentType },
      body: upload.body,
    });
    if (res.status !== 200 && res.status !== 201) {
      const error = await httpError(res);
      return { ...where, ok: false, error: { ...error, message: describeHttp(error) } };
    }
    const body = (await jsonOf(res)) as Imported & Record<string, unknown>;
    return { ...where, ok: true, ...body };
  } catch (error) {
    if (error instanceof Failure) {
      return { ...where, ok: false, error: { message: error.message } };
    }
    throw error;
  }
}

async function importFiles(ctx: Context, files: string[]): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/admin/certificates`;
  const headers = await adminHeaders(ctx);
  const results: ImportResult[] = [];
  const report = (result: ImportResult, source: string) => {
    results.push(result);
    if (ctx.json) {
      return;
    }
    if (result.ok) {
      const cn = result.summary.subjectCN ?? "(no CN)";
      ctx.io.stdout(`${result.outcome.padEnd(10)} ${result.id}  ${cn}  ${source}\n`);
    } else {
      ctx.io.stderr(`${"failed".padEnd(10)} ${source}: ${result.error.message}\n`);
    }
  };

  // One file or block failing does not stop the others.
  for (const file of files) {
    let uploads: Upload[];
    try {
      uploads = await uploadsOf(ctx.io, file);
    } catch (error) {
      if (!(error instanceof Failure)) {
        throw error;
      }
      report({ file, ok: false, error: { message: error.message } }, file);
      continue;
    }
    for (const upload of uploads) {
      report(await importOne(ctx, url, headers, upload), sourceOf(upload));
    }
  }

  const count = (outcome: string) =>
    results.filter((result) => (result.ok ? result.outcome : "failed") === outcome).length;
  const summary = {
    created: count("created"),
    unchanged: count("unchanged"),
    failed: count("failed"),
  };
  if (ctx.json) {
    printJson(ctx.io, { results, ...summary });
  } else {
    ctx.io.stdout(
      `${summary.created} created, ${summary.unchanged} unchanged, ${summary.failed} failed\n`
    );
  }
  return summary.failed === 0 ? 0 : 1;
}

// config -----------------------------------------------------------------------------------------

function configUrl(ctx: Context): string {
  return `${serviceUrl(ctx)}/api/v1/admin/config`;
}

async function configShow(ctx: Context): Promise<number> {
  const url = configUrl(ctx);
  const res = await send(ctx, url, { method: "GET", headers: await adminHeaders(ctx) });
  if (res.status === 404) {
    await res.arrayBuffer();
    // A result, not only an error: scripts (seed-dev) tell "nothing yet" from a failure by it.
    if (ctx.json) {
      printJson(ctx.io, { etag: null, config: null });
    }
    ctx.io.stderr("aia: nothing has been configured yet (HTTP 404)\n");
    return 1;
  }
  if (!res.ok) {
    throw new Failure(describeHttp(await httpError(res)));
  }
  const etag = res.headers.get("ETag");
  // As stored, also when an out-of-band write broke it: the GET exists to allow repairs.
  const text = await res.text();
  if (!ctx.json) {
    ctx.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Failure("the stored config.json is not JSON: run without --json to see it as is");
  }
  printJson(ctx.io, { etag, config });
  return 0;
}

async function loadConfigFile(io: CliIo, file: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(file);
  } catch (error) {
    throw new Failure(`cannot read ${file}: ${reasonOf(error)}`);
  }
  try {
    return decodeJson(bytes);
  } catch (error) {
    throw new Failure(`${file} is not JSON: ${reasonOf(error)}`);
  }
}

async function configValidate(ctx: Context, file: string): Promise<number> {
  const checked = checkConfigStatic(await loadConfigFile(ctx.io, file));
  if (ctx.json) {
    printJson(ctx.io, checked.ok ? { ok: true } : { ok: false, issues: checked.issues });
  } else if (checked.ok) {
    ctx.io.stdout(
      `${file}: valid offline (V1-V3, static parts of V4 / V6); ` +
        "the service checks the catalog and current-config rules (V4-V9) on apply\n"
    );
  } else {
    ctx.io.stderr(issuesText(`${file} is invalid`, checked.issues));
  }
  return checked.ok ? 0 : 1;
}

async function configApply(ctx: Context, file: string): Promise<number> {
  const checked = checkConfigStatic(await loadConfigFile(ctx.io, file));
  if (!checked.ok) {
    ctx.io.stderr(issuesText(`${file} is invalid, nothing was sent`, checked.issues));
    return 1;
  }
  const url = configUrl(ctx);
  const headers = await adminHeaders(ctx);

  // The precondition comes from a fresh GET: If-Match its ETag, or If-None-Match: * on 404.
  const current = await send(ctx, url, { method: "GET", headers });
  let precondition: Record<string, string>;
  if (current.status === 404) {
    await current.arrayBuffer();
    precondition = { "If-None-Match": "*" };
  } else if (current.ok) {
    const etag = current.headers.get("ETag");
    await current.arrayBuffer();
    if (etag === null) {
      throw new Failure(`GET ${url} answered without an ETag`);
    }
    precondition = { "If-Match": etag };
  } else {
    throw new Failure(
      `cannot read the current configuration: ${describeHttp(await httpError(current))}`
    );
  }

  const res = await send(ctx, url, {
    method: "PUT",
    headers: { ...headers, ...precondition, "Content-Type": "application/json" },
    body: JSON.stringify(checked.config),
  });
  if (res.status === 200) {
    const etag = res.headers.get("ETag");
    const config = await jsonOf(res);
    if (ctx.json) {
      printJson(ctx.io, { etag, config });
    } else {
      ctx.io.stdout(`applied ${file} (ETag ${etag ?? "missing"})\n`);
    }
    return 0;
  }
  const error = await httpError(res);
  // Not retried: the configuration that is there now may be one the operator has not seen.
  if (res.status === 412) {
    throw new Failure(
      `${describeHttp(error)}\nconfig.json changed after it was read (another apply?): ` +
        'review it with "aia config show" and apply again'
    );
  }
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  if (res.status === 422 && isConfigIssues(issues)) {
    ctx.io.stderr(issuesText(`the service rejected ${file}: ${describeHttp(error)}`, issues));
    return 1;
  }
  throw new Failure(describeHttp(error));
}

// new-target-id, health --------------------------------------------------------------------------

function newTargetId(ctx: Context): number {
  // Target ids are assigned by tools, never by the service (slice 2 step 6).
  const id = crypto.randomUUID();
  if (ctx.json) {
    printJson(ctx.io, { id });
  } else {
    ctx.io.stdout(`${id}\n`);
  }
  return 0;
}

interface Health {
  status: string;
  checks: { store: string; configuration: string };
}

async function health(ctx: Context): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/health`;
  const res = await send(ctx, url, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  let body: Partial<Health> | undefined;
  try {
    body = JSON.parse(text) as Partial<Health>;
  } catch {
    body = undefined;
  }
  if (typeof body?.status !== "string" || typeof body.checks?.store !== "string") {
    throw new Failure(`${url} did not answer with a health report (HTTP ${res.status})`);
  }
  const report = body as Health;
  if (ctx.json) {
    printJson(ctx.io, report);
  } else {
    const { store, configuration } = report.checks;
    ctx.io.stdout(`${report.status}: store ${store}, configuration ${configuration}\n`);
  }
  return report.status === "healthy" ? 0 : 1;
}

// Entry ------------------------------------------------------------------------------------------

/** The real process: global fetch, process.env, stdout / stderr and the file system. */
export function processIo(): CliIo {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readFile: (path) => readFile(path),
  };
}

// Only as a program (node src/cli/aia.ts, node dist/server/cli/aia.js): importing the module
// (tests, scripts/seed-dev.ts) runs nothing.
if (import.meta.main) {
  // `aia config show | head`: a reader that stops early closes the pipe, which is no error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
    process.exit(process.exitCode ?? 0);
  });
  process.exitCode = await main(process.argv.slice(2), processIo());
}
