// aia: the command-line client of the admin API and the CRL upload route (plan §7.4). A thin HTTP
// client on node:util parseArgs and fetch, with no dependencies of its own. This file parses the
// command line and dispatches; client.ts holds the service access and the token rules,
// commands.ts the commands.
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
import { Failure, reasonOf, UsageError } from "./client.ts";
import type { CliIo, Context } from "./client.ts";
import {
  configApply,
  configShow,
  configValidate,
  deleteCertificate,
  health,
  historyVersion,
  importFiles,
  listHistory,
  newTargetId,
  publishFiles,
} from "./commands.ts";

export type { CliIo } from "./client.ts";

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
    };
    return await run(ctx, positionals, values.out);
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

async function run(ctx: Context, positionals: string[], out: string | undefined): Promise<number> {
  const [command, ...args] = positionals;
  if (out !== undefined && (command !== "history" || args.length !== 2)) {
    throw new UsageError("--out is only for history <targetId> <sha256>");
  }
  switch (command) {
    case undefined:
      throw new UsageError("missing command");
    case "import":
      expectArgs(args, 1, "import <file...>", Infinity);
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
      expectArgs(args, 1, "publish <file...>", Infinity);
      return publishFiles(ctx, args);
    case "history": {
      expectArgs(args, 1, "history <targetId> [<sha256> --out <file>]", 2);
      const [targetId = "", sha256] = args;
      if (sha256 === undefined) {
        return listHistory(ctx, targetId);
      }
      if (out === undefined) {
        throw new UsageError("history <targetId> <sha256> needs --out <file>");
      }
      return historyVersion(ctx, targetId, sha256, out);
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

function expectArgs(args: string[], count: number, form: string, max = count): void {
  if (args.length < count || args.length > max) {
    throw new UsageError(`usage: aia ${form}`);
  }
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
