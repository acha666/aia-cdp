// aia: the command-line client of the admin API and the CRL upload route (plan §7.4). A thin HTTP
// client on node:util parseArgs and fetch, with no dependencies of its own. From the core it shares
// isDerSequence / splitPemBlocks (the API takes one certificate per request, so a PEM bundle goes
// block by block) and the static config rules (`config validate` runs offline). Success bodies are
// typed by the service's schemas (type-only imports) and not checked again here.
//
//   node src/cli/aia.ts <command> …          (pnpm aia …; Node runs the source)
//   node dist/server/cli/aia.js <command> …  (the Docker image)
//
// main(argv, io) does all I/O through `io`, so tests inject fetch = app.request. Exit codes: 0
// success, 1 the operation failed (or the service is not healthy), 2 usage error. Tokens are never
// printed, and go over plain http:// only to a loopback host or with --allow-insecure-http.
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import type { z } from "zod";
import { validateConfig } from "../core/admin.ts";
import type { ConfigIssue } from "../core/admin.ts";
import { decodeJson } from "../core/catalog.ts";
import type { CertificateReference } from "../core/certificates.ts";
import type { HealthReport } from "../core/health.ts";
import { isDerSequence, splitPemBlocks } from "../core/pki/pem.ts";
import type { CrlHistory, ImportedCertificate, PublishedCrl } from "../http/schemas.ts";

export interface CliIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Readonly<Record<string, string | undefined>>;
  /** Each call receives finished text, newlines included. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

export const USAGE = `Usage: aia [options] <command>

Commands:
  import <file...>        Import CA certificates: DER, or PEM with one or more blocks
                          (each block is imported on its own)
  config show             Print the stored config.json
  config validate <file>  Check a configuration offline: rules V1-V3 and the static parts of
                          V4 / V6; the rest (V4-V9) needs the service and is checked on apply
  config apply <file>     Validate, then replace config.json as a whole (If-Match: the ETag of a
                          fresh GET; If-None-Match: * for the first configuration). What is
                          stored is overwritten, also changes you have not seen: the precondition
                          only catches one made between this command's GET and PUT. Removing a
                          target retires it: nothing serves it, its history stays
  new-target-id           Print a new target id (a random UUID)
  publish <file...>       Publish CRLs, DER or PEM, one upload per file: created, updated and
                          unchanged succeed; anything else (stale_crl, ...) fails that file
  history <targetId>      List the CRL versions a target has published, newest first (also
                          once the target is removed from config.json)
  history <targetId> <sha256> --out <file>
                          Write the DER of one of those versions to <file>
  delete-certificate <id> Delete an imported certificate that nothing references (the
                          verifier of a target's current CRL stays referenced)
  health                  Exit 0 only if the service reports healthy

Options:
  --url <url>             Service base URL (default: $AIA_URL)
  --token-file <file>     File holding the token of the command. import, config, history and
                          delete-certificate: the admin token (default: $AIA_ADMIN_TOKEN_FILE,
                          else $AIA_ADMIN_TOKEN).
                          publish: the upload token (default: $AIA_UPLOAD_TOKEN_FILE, else
                          $AIA_UPLOAD_TOKEN, else none: the service needs it only when set)
  --allow-insecure-http   Send the token over plain http:// to a host other than localhost,
                          127.0.0.0/8 or [::1] (refused otherwise: it would cross the network
                          in clear text)
  --out <file>            history <targetId> <sha256>: where to write the DER
  --json                  Print results as JSON on stdout (errors stay text on stderr)
  -h, --help              Show this help

Exit codes: 0 success, 1 failure or not healthy, 2 usage error.
`;

const OPTIONS = {
  url: { type: "string" },
  "token-file": { type: "string" },
  "allow-insecure-http": { type: "boolean" },
  out: { type: "string" },
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
  /** --token-file: wins over both variables of the command's token. */
  tokenFile: string | undefined;
  /** --allow-insecure-http: a token may go over http:// to any host. */
  allowInsecureHttp: boolean;
  /** --out: only for history <targetId> <sha256>. */
  out: string | undefined;
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
    const ctx: Context = {
      io,
      json: values.json === true,
      url: values.url ?? io.env.AIA_URL,
      tokenFile: values["token-file"],
      allowInsecureHttp: values["allow-insecure-http"] === true,
      out: values.out,
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
  if (ctx.out !== undefined && (command !== "history" || args.length !== 2)) {
    throw new UsageError("--out is only for history <targetId> <sha256>");
  }
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
    case "publish":
      if (args.length === 0) {
        throw new UsageError("publish needs at least one file");
      }
      return publishFiles(ctx, args);
    case "history": {
      const [targetId, sha256, ...rest] = args;
      if (targetId === undefined || rest.length > 0) {
        throw new UsageError("usage: aia history <targetId> [<sha256> --out <file>]");
      }
      return sha256 === undefined
        ? listHistory(ctx, targetId)
        : historyVersion(ctx, targetId, sha256);
    }
    case "delete-certificate":
      expectArgs(args, 1, "delete-certificate <id>");
      return deleteCertificate(ctx, args[0] ?? "");
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

/** io.readFile; a file that cannot be read throws `fail(reason)`. */
async function readBytes(
  io: CliIo,
  file: string,
  fail: (reason: string) => Error
): Promise<Uint8Array> {
  try {
    return await io.readFile(file);
  } catch (error) {
    throw fail(reasonOf(error));
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

/** --url / AIA_URL, parsed: an http:// or https:// URL. */
function parsedServiceUrl(ctx: Context): URL {
  if (ctx.url === undefined || ctx.url === "") {
    throw new UsageError("no service URL: pass --url or set AIA_URL");
  }
  const url = URL.parse(ctx.url);
  if (url === null) {
    throw new UsageError("--url / AIA_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--url / AIA_URL must be an http:// or https:// URL");
  }
  return url;
}

/** The base URL without a trailing slash; a path prefix (behind a proxy) is kept. */
function serviceUrl(ctx: Context): string {
  const url = parsedServiceUrl(ctx);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * localhost, 127.0.0.0/8 or [::1]: the Docker exec and development setups. The URL parser has
 * normalized the host already (127.1 → 127.0.0.1, [0:0:0:0:0:0:0:1] → [::1], case).
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
  );
}

/**
 * A token goes over https://, or over http:// to a loopback host, unless --allow-insecure-http.
 * The production host answers plain HTTP with no redirect (AIA / CDP clients need it), so
 * http://<host> reaches the service and would put the token on the wire in clear text.
 */
function checkTokenTransport(ctx: Context, name: string): void {
  const url = parsedServiceUrl(ctx);
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !ctx.allowInsecureHttp) {
    throw new UsageError(
      `refusing to send the ${name} token over http:// to ${url.host}: use https://, ` +
        "or pass --allow-insecure-http"
    );
  }
}

/** The admin token (import, config) or the upload token (publish). */
type TokenVariable = "AIA_ADMIN_TOKEN" | "AIA_UPLOAD_TOKEN";

const TOKEN_NAMES: Record<TokenVariable, string> = {
  AIA_ADMIN_TOKEN: "admin",
  AIA_UPLOAD_TOKEN: "upload",
};

/**
 * The command's bearer token, from --token-file, else `<variable>_FILE`, else `<variable>`
 * (trimmed); undefined when none of them is set. Both variables set, an unreadable file, an
 * empty or malformed token, or a token that checkTokenTransport refuses is a usage error.
 * Messages name the source, never the token.
 */
async function bearerToken(ctx: Context, variable: TokenVariable): Promise<string | undefined> {
  const { env } = ctx.io;
  const name = TOKEN_NAMES[variable];
  const fileVariable = `${variable}_FILE`;
  const file = ctx.tokenFile ?? env[fileVariable];
  let token: string | undefined;
  let source: string;
  if (file !== undefined && file !== "") {
    if (ctx.tokenFile === undefined && env[variable] !== undefined) {
      throw new UsageError(`set either ${variable} or ${fileVariable}, not both`);
    }
    source = `the token file ${file}`;
    const fail = (reason: string) => new UsageError(`cannot read ${source}: ${reason}`);
    token = new TextDecoder().decode(await readBytes(ctx.io, file, fail)).trim();
  } else {
    source = variable;
    token = env[variable]?.trim();
  }
  if (token === "") {
    throw new UsageError(`the ${name} token in ${source} is empty`);
  }
  if (token !== undefined && !BEARER_TOKEN.test(token)) {
    throw new UsageError(
      `the ${name} token in ${source} has characters a bearer token cannot have ` +
        "(letters, digits and - . _ ~ + / only, optionally ending in =)"
    );
  }
  if (token !== undefined) {
    checkTokenTransport(ctx, name);
  }
  return token;
}

/** `Authorization` for the admin routes: the admin token is required. */
async function adminHeaders(ctx: Context): Promise<Record<string, string>> {
  const token = await bearerToken(ctx, "AIA_ADMIN_TOKEN");
  if (token === undefined) {
    throw new UsageError(
      "no admin token: pass --token-file, or set AIA_ADMIN_TOKEN_FILE or AIA_ADMIN_TOKEN"
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** fetch with a timeout; a request that gets no response at all is a Failure. */
async function send(ctx: Context, url: string, init: RequestInit): Promise<Response> {
  try {
    return await ctx.io.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Failure(`cannot reach ${url}: ${reasonOf(error)}`);
  }
}

/**
 * The body of a response from `url` as text. Every body is read through here: one that fails
 * after the headers (a reset connection, the timeout firing mid-body) is a Failure too.
 */
async function readText(res: Response, url: string): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    throw new Failure(`cannot read the response from ${url}: ${reasonOf(error)}`);
  }
}

/** A non-success response: the error envelope's fields, or the status line without one. */
interface HttpError {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
}

async function httpError(res: Response, url: string): Promise<HttpError> {
  const text = await readText(res, url);
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

/** The body of a success response as bytes; one that fails to arrive is a Failure. */
async function readBody(res: Response, url: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    throw new Failure(`cannot read the response from ${url}: ${reasonOf(error)}`);
  }
}

/** The JSON body of a success response; a body that is not JSON is a Failure. */
async function jsonOf(res: Response, url: string): Promise<unknown> {
  const text = await readText(res, url);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Failure(`HTTP ${res.status}, but the body is not JSON`);
  }
}

// import, publish --------------------------------------------------------------------------------

/** Where a result comes from: the file, and the 1-based block number within a PEM bundle. */
interface Where {
  file: string;
  block?: number;
}

type ItemFailure = Where & { ok: false; error: { message: string } & Partial<HttpError> };

/** One line of the import or publish report (`--json`: the array `results`). */
type ItemResult<T> = (Where & { ok: true } & T) | ItemFailure;

/** An import or publish file that cannot be read; its report line names the file. */
function unreadable(reason: string): Failure {
  return new Failure(`cannot read the file: ${reason}`);
}

/** A Failure as the result of the item it stopped; any other error propagates. */
function failedItem(where: Where, error: unknown): ItemFailure {
  if (!(error instanceof Failure)) {
    throw error;
  }
  return { ...where, ok: false, error: { message: error.message } };
}

/**
 * POSTs one upload. The service recognizes the format from the bytes, so every body goes as
 * application/octet-stream. An error response, or a Failure on the way, is the item's failure;
 * `describe` writes the message of an error response.
 */
async function postItem<T>(
  ctx: Context,
  url: string,
  headers: Record<string, string>,
  where: Where,
  body: Uint8Array | string,
  describe: (error: HttpError) => string = describeHttp
): Promise<ItemResult<T>> {
  try {
    const res = await send(ctx, url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body,
    });
    if (res.status !== 200 && res.status !== 201) {
      const error = await httpError(res, url);
      return { ...where, ok: false, error: { ...error, message: describe(error) } };
    }
    return { ...where, ok: true, ...((await jsonOf(res, url)) as T) };
  } catch (error) {
    return failedItem(where, error);
  }
}

/** The report line of one item as it completes; `okText` writes what a success names. */
function printItem<T extends { outcome: string }>(
  ctx: Context,
  result: ItemResult<T>,
  source: string,
  okText: (body: T) => string
): void {
  if (ctx.json) {
    return;
  }
  if (result.ok) {
    ctx.io.stdout(`${result.outcome.padEnd(10)} ${okText(result)}  ${source}\n`);
  } else {
    ctx.io.stderr(`${"failed".padEnd(10)} ${source}: ${result.error.message}\n`);
  }
}

/**
 * Prints the summary, the count of each of `outcomes` and then of the failures (`--json`: after
 * `results`), and returns the exit code: 1 when anything failed.
 */
function finish(
  ctx: Context,
  results: readonly ItemResult<{ outcome: string }>[],
  outcomes: readonly string[]
): number {
  const summary = Object.fromEntries(
    [...outcomes, "failed"].map((outcome) => [
      outcome,
      results.filter((result) => (result.ok ? result.outcome : "failed") === outcome).length,
    ])
  );
  if (ctx.json) {
    printJson(ctx.io, { results, ...summary });
  } else {
    const counts = Object.entries(summary).map(([outcome, count]) => `${count} ${outcome}`);
    ctx.io.stdout(`${counts.join(", ")}\n`);
  }
  return summary.failed === 0 ? 0 : 1;
}

// import -----------------------------------------------------------------------------------------

type Imported = z.infer<typeof ImportedCertificate>;

/** What one POST sends: a whole DER file, or one block of a PEM file. */
interface Upload {
  file: string;
  /** 1-based block number within a PEM file, and the file's block count. */
  block?: { index: number; count: number };
  body: Uint8Array | string;
}

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
  const bytes = await readBytes(io, file, unreadable);
  const text = new TextDecoder().decode(bytes);
  if (isDerSequence(bytes) || !text.includes("-----BEGIN ")) {
    return [{ file, body: bytes }];
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
    body,
  }));
}

async function importFiles(ctx: Context, files: string[]): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/admin/certificates`;
  const headers = await adminHeaders(ctx);
  const results: ItemResult<Imported>[] = [];
  const report = (result: ItemResult<Imported>, source: string) => {
    results.push(result);
    printItem(ctx, result, source, (cert) => `${cert.id}  ${cert.summary.subjectCN ?? "(no CN)"}`);
  };

  // One file or block failing does not stop the others.
  for (const file of files) {
    let uploads: Upload[];
    try {
      uploads = await uploadsOf(ctx.io, file);
    } catch (error) {
      report(failedItem({ file }, error), file);
      continue;
    }
    for (const upload of uploads) {
      const where = { file, ...(upload.block === undefined ? {} : { block: upload.block.index }) };
      report(await postItem(ctx, url, headers, where, upload.body), sourceOf(upload));
    }
  }
  return finish(ctx, results, ["created", "unchanged"]);
}

// publish ----------------------------------------------------------------------------------------

type Published = z.infer<typeof PublishedCrl>;

/** A failure's details beyond `reason` (which describeHttp prints), for the text report. */
function detailsText(details: unknown): string {
  if (typeof details !== "object" || details === null) {
    return "";
  }
  const parts = Object.entries(details).flatMap(([key, value]) => {
    if (key === "reason") {
      return [];
    }
    const current = value as { crlNumber?: unknown; thisUpdate?: unknown } | null;
    if (key === "current" && typeof current?.thisUpdate === "string") {
      const number =
        typeof current.crlNumber === "string" ? `CRL Number ${current.crlNumber}` : "no CRL Number";
      return [`current: ${number}, thisUpdate ${current.thisUpdate}`];
    }
    return [`${key} ${typeof value === "string" ? value : JSON.stringify(value)}`];
  });
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

/**
 * Each file is one upload, sent as is (a PEM bundle is the service's pem_blocks, never split
 * here); one failing does not stop the others.
 */
async function publishFiles(ctx: Context, files: string[]): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/crls`;
  const token = await bearerToken(ctx, "AIA_UPLOAD_TOKEN");
  const headers: Record<string, string> =
    token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const describe = (error: HttpError) => `${describeHttp(error)}${detailsText(error.details)}`;
  const results: ItemResult<Published>[] = [];
  for (const file of files) {
    let result: ItemResult<Published>;
    try {
      const bytes = await readBytes(ctx.io, file, unreadable);
      result = await postItem(ctx, url, headers, { file }, bytes, describe);
    } catch (error) {
      result = failedItem({ file }, error);
    }
    results.push(result);
    printItem(ctx, result, file, (crl) => {
      const number = crl.crlNumber === null ? "(no CRL Number)" : `#${crl.crlNumber}`;
      return `${crl.target}  ${crl.kind} ${number}`;
    });
  }
  return finish(ctx, results, ["created", "updated", "unchanged"]);
}

// config -----------------------------------------------------------------------------------------

function configUrl(ctx: Context): string {
  return `${serviceUrl(ctx)}/api/v1/admin/config`;
}

async function configShow(ctx: Context): Promise<number> {
  const url = configUrl(ctx);
  const res = await send(ctx, url, { method: "GET", headers: await adminHeaders(ctx) });
  if (res.status === 404) {
    await readText(res, url);
    throw new Failure("nothing has been configured yet (HTTP 404)");
  }
  if (!res.ok) {
    throw new Failure(describeHttp(await httpError(res, url)));
  }
  const etag = res.headers.get("ETag");
  // As stored, also when an out-of-band write broke it: the GET exists to allow repairs.
  const text = await readText(res, url);
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
  const fail = (reason: string) => new Failure(`cannot read ${file}: ${reason}`);
  const bytes = await readBytes(io, file, fail);
  try {
    return decodeJson(bytes);
  } catch (error) {
    throw new Failure(`${file} is not JSON: ${reasonOf(error)}`);
  }
}

async function configValidate(ctx: Context, file: string): Promise<number> {
  const checked = validateConfig(await loadConfigFile(ctx.io, file));
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
  const checked = validateConfig(await loadConfigFile(ctx.io, file));
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
    await readText(current, url);
    precondition = { "If-None-Match": "*" };
  } else if (current.ok) {
    const etag = current.headers.get("ETag");
    await readText(current, url);
    if (etag === null) {
      throw new Failure(`GET ${url} answered without an ETag`);
    }
    precondition = { "If-Match": etag };
  } else {
    throw new Failure(
      `cannot read the current configuration: ${describeHttp(await httpError(current, url))}`
    );
  }

  const res = await send(ctx, url, {
    method: "PUT",
    headers: { ...headers, ...precondition, "Content-Type": "application/json" },
    body: JSON.stringify(checked.config),
  });
  if (res.status === 200) {
    const etag = res.headers.get("ETag");
    const config = await jsonOf(res, url);
    if (ctx.json) {
      printJson(ctx.io, { etag, config });
    } else {
      ctx.io.stdout(`applied ${file} (ETag ${etag ?? "missing"})\n`);
    }
    return 0;
  }
  const error = await httpError(res, url);
  // Not retried: the configuration that is there now may be one the operator has not seen.
  if (res.status === 412) {
    throw new Failure(
      `${describeHttp(error)}\nconfig.json changed after it was read (another apply?): ` +
        'review it with "aia config show" and apply again'
    );
  }
  if (res.status === 422 && error.code === "config_invalid") {
    const { issues } = error.details as { issues: ConfigIssue[] };
    ctx.io.stderr(issuesText(`the service rejected ${file}: ${describeHttp(error)}`, issues));
    return 1;
  }
  throw new Failure(describeHttp(error));
}

// history, delete-certificate --------------------------------------------------------------------

type History = z.infer<typeof CrlHistory>;

function historyUrl(ctx: Context, targetId: string): string {
  return `${serviceUrl(ctx)}/api/v1/admin/crls/${encodeURIComponent(targetId)}/history`;
}

async function listHistory(ctx: Context, targetId: string): Promise<number> {
  const url = historyUrl(ctx, targetId);
  const res = await send(ctx, url, { method: "GET", headers: await adminHeaders(ctx) });
  if (!res.ok) {
    throw new Failure(describeHttp(await httpError(res, url)));
  }
  const history = (await jsonOf(res, url)) as History;
  if (ctx.json) {
    printJson(ctx.io, history);
    return 0;
  }
  const numbers = history.entries.map((entry) =>
    entry.crlNumber === null ? "(no CRL Number)" : `#${entry.crlNumber}`
  );
  const width = Math.max(0, ...numbers.map((number) => number.length));
  history.entries.forEach((entry, index) => {
    const line = [
      entry.thisUpdate,
      (numbers[index] ?? "").padEnd(width),
      entry.sha256,
      `${entry.size} B`,
      entry.current ? "current" : "",
    ];
    ctx.io.stdout(`${line.join("  ").trimEnd()}\n`);
  });
  const count = `${history.entries.length} version${history.entries.length === 1 ? "" : "s"}`;
  const removed = history.configured ? "" : "; the target is not in config.json (retired)";
  ctx.io.stdout(`${count}${removed}\n`);
  return 0;
}

async function historyVersion(ctx: Context, targetId: string, sha256: string): Promise<number> {
  const file = ctx.out;
  if (file === undefined) {
    throw new UsageError("history <targetId> <sha256> needs --out <file>");
  }
  const url = `${historyUrl(ctx, targetId)}/${encodeURIComponent(sha256)}`;
  const res = await send(ctx, url, { method: "GET", headers: await adminHeaders(ctx) });
  if (!res.ok) {
    throw new Failure(describeHttp(await httpError(res, url)));
  }
  const der = await readBody(res, url);
  try {
    await ctx.io.writeFile(file, der);
  } catch (error) {
    throw new Failure(`cannot write ${file}: ${reasonOf(error)}`);
  }
  if (ctx.json) {
    printJson(ctx.io, { file, size: der.byteLength });
  } else {
    ctx.io.stdout(`wrote ${file} (${der.byteLength} B)\n`);
  }
  return 0;
}

async function deleteCertificate(ctx: Context, id: string): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/admin/certificates/${encodeURIComponent(id)}`;
  const res = await send(ctx, url, { method: "DELETE", headers: await adminHeaders(ctx) });
  if (res.status === 204) {
    await readText(res, url);
    if (ctx.json) {
      printJson(ctx.io, { deleted: id });
    } else {
      ctx.io.stdout(`deleted ${id}\n`);
    }
    return 0;
  }
  const error = await httpError(res, url);
  if (error.code === "referenced") {
    const { references } = error.details as { references: CertificateReference[] };
    const lines = references.map(
      (reference) => `  ${reference.object} ${pathText(reference.path)}`
    );
    ctx.io.stderr(`aia: ${describeHttp(error)}\n${lines.join("\n")}\n`);
    return 1;
  }
  throw new Failure(describeHttp(error));
}

// new-target-id, health --------------------------------------------------------------------------

function newTargetId(ctx: Context): number {
  // Target ids are assigned by tools, never by the service.
  const id = crypto.randomUUID();
  if (ctx.json) {
    printJson(ctx.io, { id });
  } else {
    ctx.io.stdout(`${id}\n`);
  }
  return 0;
}

async function health(ctx: Context): Promise<number> {
  const url = `${serviceUrl(ctx)}/api/v1/health`;
  const res = await send(ctx, url, { method: "GET" });
  // 200 (healthy, degraded) and 503 (unhealthy) carry the report.
  if (res.status !== 200 && res.status !== 503) {
    throw new Failure(describeHttp(await httpError(res, url)));
  }
  const report = (await jsonOf(res, url)) as HealthReport;
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
    writeFile: (path, bytes) => writeFile(path, bytes),
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
