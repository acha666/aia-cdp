// Environment settings (plan §4.2), shared by the Node and Workers entries: pure zod, no node:*.
// Node reads `*_FILE` variants first (resolveFileVariants with readFileSync); Workers pass their
// vars / secrets straight to parseSettings.
import { z } from "zod";
import type { AppSettings } from "../http/types.ts";

export interface Settings {
  /** 0 picks a free port (tests, smoke scripts). */
  port: number;
  store: "fs";
  /** fs store root; one service process per directory. */
  dataDir: string;
  /** Built UI (vite build output). */
  staticDir: string;
  app: AppSettings;
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Variables that may instead be read from the file named by `<NAME>_FILE`. */
export const FILE_VARIANTS = ["AIA_ADMIN_TOKEN", "AIA_UPLOAD_TOKEN"] as const;

type Env = Readonly<Record<string, string | undefined>>;

function integer(min: number, max: number, message: string) {
  return z
    .string()
    .regex(/^[0-9]{1,16}$/, message)
    .transform(Number)
    .refine((n) => n >= min && n <= max, message);
}

const nonEmpty = (message: string) => z.string().min(1, message);

// RFC 6750 b64token, the only token syntax a Bearer Authorization header carries (bearerAuth's own
// pattern): a token with any other character (`$`, `!`, a space, …) could never authenticate, as
// every request would get 400, so it is an invalid setting instead.
const bearerToken = z
  .string()
  .min(1, { message: "must not be empty when set", abort: true })
  .regex(
    /^[A-Za-z0-9._~+/-]+=*$/,
    "must be a bearer token: letters, digits and - . _ ~ + /, optionally ending in ="
  );

// Messages never echo the value: two of these variables are secrets.
const SettingsSchema = z.object({
  PORT: integer(0, 65535, "must be an integer from 0 to 65535").default(8080),
  AIA_STORE: z.enum(["fs"], 'must be "fs"').default("fs"),
  AIA_DATA_DIR: nonEmpty("must not be empty").default("/data"),
  AIA_STATIC_DIR: nonEmpty("must not be empty").default("./dist/web"),
  AIA_ADMIN_TOKEN: bearerToken.optional(),
  AIA_UPLOAD_TOKEN: bearerToken.optional(),
  AIA_MAX_UPLOAD_BYTES: integer(
    1,
    Number.MAX_SAFE_INTEGER,
    "must be a positive integer (bytes)"
  ).default(10_485_760),
  AIA_TRUST_PROXY: z
    .enum(["true", "false"], 'must be "true" or "false"')
    .transform((value) => value === "true")
    .default(false),
  AIA_LOG_FORMAT: z.enum(["json", "pretty"], 'must be "json" or "pretty"').default("json"),
});

/**
 * Validates the environment and applies the plan §4.2 defaults; `parseSettings({})` is the
 * all-defaults configuration (tests, OpenAPI generator). Unknown variables are ignored. On failure
 * `error` lists every invalid variable, one per line.
 */
export function parseSettings(env: Env): SettingsResult<Settings> {
  const result = SettingsSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.map(String).join(".")}: ${issue.message}`
    );
    return { ok: false, error: ["Invalid settings:", ...lines].join("\n") };
  }
  const v = result.data;
  return {
    ok: true,
    value: {
      port: v.PORT,
      store: v.AIA_STORE,
      dataDir: v.AIA_DATA_DIR,
      staticDir: v.AIA_STATIC_DIR,
      app: {
        logFormat: v.AIA_LOG_FORMAT,
        trustProxy: v.AIA_TRUST_PROXY,
        maxUploadBytes: v.AIA_MAX_UPLOAD_BYTES,
        ...(v.AIA_ADMIN_TOKEN === undefined ? {} : { adminToken: v.AIA_ADMIN_TOKEN }),
        ...(v.AIA_UPLOAD_TOKEN === undefined ? {} : { uploadToken: v.AIA_UPLOAD_TOKEN }),
      },
    },
  };
}

/**
 * For each FILE_VARIANTS name: when `<NAME>_FILE` is set, `<NAME>` becomes that file's content
 * minus one trailing newline (`\n` or `\r\n`). Setting both `<NAME>` and `<NAME>_FILE` is an
 * error. Returns a copy of `env` without the `_FILE` entries; `readText` is the only I/O.
 */
export function resolveFileVariants(
  env: Env,
  readText: (path: string) => string
): SettingsResult<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = { ...env };
  const errors: string[] = [];
  for (const name of FILE_VARIANTS) {
    const fileVar = `${name}_FILE`;
    const path = env[fileVar];
    delete resolved[fileVar];
    if (path === undefined) {
      continue;
    }
    if (env[name] !== undefined) {
      errors.push(`  ${name}: set either ${name} or ${fileVar}, not both`);
    } else if (path === "") {
      errors.push(`  ${fileVar}: must name a file`);
    } else {
      try {
        resolved[name] = readText(path).replace(/\r?\n$/, "");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push(`  ${fileVar}: cannot read ${JSON.stringify(path)}: ${reason}`);
      }
    }
  }
  return errors.length > 0
    ? { ok: false, error: ["Invalid settings:", ...errors].join("\n") }
    : { ok: true, value: resolved };
}
