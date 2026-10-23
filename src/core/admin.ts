// Configuration rules and apply (plan §5.2).
//
// The rules V1–V9 come in three layers, exported separately:
// - static (V1–V3, V4 / V6 static parts): the document alone. The CLI's `config validate` runs it
//   offline.
// - state (V4 / V6 catalog parts, V5): the document against catalog.json. Health runs static +
//   state.
// - migration (V7–V9): the document against the current config.json and catalog.json, at apply
//   time only.
//
// There is no rebind ledger: V7 compares with the current config only, so a `/ca/` path removed by
// one apply and re-added for another certificate by a later one is not detected. Certificate
// downloads are cached `immutable` for a year: a new CA certificate needs a new path, which is the
// operator's responsibility.
import type { z } from "zod";
import {
  CONFIG_KEY,
  ConfigSchema,
  decodeJson,
  encodeJson,
  JSON_CONTENT_TYPE,
  readCatalog,
} from "./catalog.ts";
import type { Catalog, Config, CrlKind } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import type { ObjectStore } from "./store.ts";

/** `rule` of a config_invalid issue (the HTTP schema enumerates it). */
export const CONFIG_RULES = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9"] as const;

export type ConfigRule = (typeof CONFIG_RULES)[number];

/** One violation: `details.issues[]` of config_invalid. */
export interface ConfigIssue {
  /** Keys from the document root, e.g. ["paths", "/ca/root-ca.crt"]; [] for the whole document. */
  path: (string | number)[];
  rule: ConfigRule;
  message: string;
}

export type ConfigCheck = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

// Stable, so issues of one rule keep the document's order.
function byRule(issues: ConfigIssue[]): ConfigIssue[] {
  return issues.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

// Static layer -----------------------------------------------------------------------------------

// V2: the character set is the canonical form, so "unique after normalization" is just unique
// keys. Case-sensitive, matched exactly by the download routes.
const PATH_SYNTAX = /^\/(?:ca|crl|dcrl)(?:\/[A-Za-z0-9._~-]+)+$/;
const PATH_PREFIX = /^\/(ca|crl|dcrl)\//;

const KIND_BY_PREFIX: Record<string, CrlKind> = { crl: "full", dcrl: "delta" };

const PATH_SYNTAX_MESSAGE =
  "Expected /ca/, /crl/ or /dcrl/ followed by segments of [A-Za-z0-9._~-] " +
  "(no empty segment, trailing /, % or other character)";

function pathSyntaxProblem(path: string): string | undefined {
  if (!PATH_SYNTAX.test(path)) {
    return PATH_SYNTAX_MESSAGE;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "A path segment must not be . or ..";
  }
  if (path.endsWith(".pem")) {
    return "A path must not end in .pem: <path>.pem is the derived PEM variant";
  }
  return undefined;
}

function staticIssues(config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [path, entry] of Object.entries(config.paths)) {
    const at = ["paths", path];
    const problem = pathSyntaxProblem(path);
    if (problem !== undefined) {
      issues.push({ path: at, rule: "V2", message: problem });
    }
    // V3 needs the prefix only; a path with an unknown prefix is V2's alone.
    const prefix = PATH_PREFIX.exec(path)?.[1];
    if ("certificate" in entry) {
      if (prefix !== undefined && prefix !== "ca") {
        issues.push({
          path: at,
          rule: "V3",
          message: `A /${prefix}/ path serves a CRL: map it to { target }`,
        });
      }
      continue;
    }
    const target = config.targets[entry.target];
    if (target === undefined) {
      issues.push({
        path: [...at, "target"],
        rule: "V4",
        message: `Target ${entry.target} is not in targets`,
      });
    }
    if (prefix === "ca") {
      issues.push({
        path: at,
        rule: "V3",
        message: "A /ca/ path serves a certificate: map it to { certificate }",
      });
    } else if (prefix !== undefined && target !== undefined) {
      const kind = KIND_BY_PREFIX[prefix];
      if (target.kind !== kind) {
        issues.push({
          path: [...at, "target"],
          rule: "V3",
          message: `A /${prefix}/ path serves a ${kind} target; ${entry.target} is ${target.kind}`,
        });
      }
    }
  }
  // V6, static part: one target per (issuer, kind).
  const seen = new Map<string, string>();
  for (const [id, target] of Object.entries(config.targets)) {
    const slot = `${target.issuer}/${target.kind}`;
    const first = seen.get(slot);
    if (first === undefined) {
      seen.set(slot, id);
    } else {
      issues.push({
        path: ["targets", id],
        rule: "V6",
        message: `Target ${first} already is the ${target.kind} target of issuer ${target.issuer}`,
      });
    }
  }
  return issues;
}

/** The V1 issues of a failed ConfigSchema parse. */
export function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    rule: "V1",
    // zod reports a bad record key as "Invalid key in record"; say what is wrong with it.
    message:
      issue.code === "invalid_key"
        ? `Invalid key: ${issue.issues.map((inner) => inner.message).join("; ")}`
        : issue.message,
  }));
}

// V1, then the other static rules on a schema-valid document. `config` is undefined when V1 fails:
// the other rules need a well-formed document and do not run.
function staticLayer(value: unknown): { config: Config | undefined; issues: ConfigIssue[] } {
  const parsed = ConfigSchema.safeParse(value);
  if (parsed.success) {
    return { config: parsed.data, issues: staticIssues(parsed.data) };
  }
  return { config: undefined, issues: schemaIssues(parsed.error) };
}

/**
 * V1 (ConfigSchema, strict) and, on a schema-valid document, V2, V3 and the static parts of V4
 * (path targets exist) and V6 (one target per issuer and kind). Needs no store.
 */
export function checkConfigStatic(value: unknown): ConfigCheck {
  const { config, issues } = staticLayer(value);
  return config !== undefined && issues.length === 0
    ? { ok: true, config }
    : { ok: false, issues: byRule(issues) };
}

// State layer ------------------------------------------------------------------------------------

/**
 * V4 (certificates keys, path certificates and target issuers are in the catalog), V5 (a target's
 * issuer has a Subject Key Identifier: CRLs are matched to issuers by AKI = SKI) and V6's catalog
 * part: two different certificates with the same SKI, such as a renewal on the same key, must not
 * each have a target of the same kind, or a CRL could not be attributed to one of them.
 */
export function checkConfigState(config: Config, catalog: Catalog): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const notImported = (id: string) => `Certificate ${id} has not been imported`;
  for (const id of Object.keys(config.certificates)) {
    if (catalog.certificates[id] === undefined) {
      issues.push({ path: ["certificates", id], rule: "V4", message: notImported(id) });
    }
  }
  for (const [path, entry] of Object.entries(config.paths)) {
    if ("certificate" in entry && catalog.certificates[entry.certificate] === undefined) {
      issues.push({
        path: ["paths", path, "certificate"],
        rule: "V4",
        message: notImported(entry.certificate),
      });
    }
  }
  const bySubjectKey = new Map<string, { id: string; issuer: string }>();
  for (const [id, target] of Object.entries(config.targets)) {
    const at = ["targets", id, "issuer"];
    const issuer = catalog.certificates[target.issuer];
    if (issuer === undefined) {
      issues.push({ path: at, rule: "V4", message: notImported(target.issuer) });
      continue;
    }
    const subjectKeyId = issuer.summary.subjectKeyId;
    if (subjectKeyId === null) {
      issues.push({
        path: at,
        rule: "V5",
        message: `Certificate ${target.issuer} has no Subject Key Identifier, so no CRL can be matched to it`,
      });
      continue;
    }
    const slot = `${subjectKeyId}/${target.kind}`;
    const first = bySubjectKey.get(slot);
    if (first === undefined) {
      bySubjectKey.set(slot, { id, issuer: target.issuer });
    } else if (first.issuer !== target.issuer) {
      issues.push({
        path: at,
        rule: "V6",
        message:
          `Certificate ${target.issuer} has the same Subject Key Identifier as ${first.issuer}, ` +
          `the issuer of ${target.kind} target ${first.id}`,
      });
    }
  }
  return issues;
}

// Migration layer --------------------------------------------------------------------------------

/**
 * V7 (a `/ca/` path in both the current and the new config keeps its certificate) and V9 (a target
 * id in both keeps its issuer and kind: a target's current CRL and its whole history are verified
 * by one certificate) compare with `current`, and are skipped without one. V8 (a target with a
 * current CRL stays in the config until it is retired) needs only the catalog.
 */
export function checkConfigMigration(
  config: Config,
  catalog: Catalog,
  current: Config | undefined
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (current !== undefined) {
    for (const [path, entry] of Object.entries(config.paths)) {
      // Own properties only: a path key is any string until V2 has looked at it.
      const before = Object.hasOwn(current.paths, path) ? current.paths[path] : undefined;
      if (
        path.startsWith("/ca/") &&
        "certificate" in entry &&
        before !== undefined &&
        "certificate" in before &&
        before.certificate !== entry.certificate
      ) {
        issues.push({
          path: ["paths", path, "certificate"],
          rule: "V7",
          message:
            `${path} serves certificate ${before.certificate}, which clients cache as immutable ` +
            "for a year: publish another certificate under a new path",
        });
      }
    }
  }
  for (const [id, target] of Object.entries(catalog.targets)) {
    if (target.current !== null && config.targets[id] === undefined) {
      issues.push({
        path: ["targets", id],
        rule: "V8",
        message: `Target ${id} has a current CRL: retire it before removing the target`,
      });
    }
  }
  if (current !== undefined) {
    for (const [id, target] of Object.entries(config.targets)) {
      const before = current.targets[id];
      for (const field of ["issuer", "kind"] as const) {
        if (before !== undefined && before[field] !== target[field]) {
          issues.push({
            path: ["targets", id, field],
            rule: "V9",
            message: `Target ${id} has ${field} ${before[field]}: use a new target id for another ${field}`,
          });
        }
      }
    }
  }
  return issues;
}

// Whole ------------------------------------------------------------------------------------------

export interface ValidationContext {
  catalog: Catalog;
  /** The current config.json; omitted when missing or not valid, which skips V7 and V9. */
  current?: Config | undefined;
}

/** V1–V9: every violation at once, ordered by rule (the static layer alone when V1 fails). */
export function validateConfig(value: unknown, context: ValidationContext): ConfigCheck {
  const { config, issues } = staticLayer(value);
  if (config === undefined) {
    return { ok: false, issues: byRule(issues) };
  }
  const all = byRule([
    ...issues,
    ...checkConfigState(config, context.catalog),
    ...checkConfigMigration(config, context.catalog, context.current),
  ]);
  return all.length === 0 ? { ok: true, config } : { ok: false, issues: all };
}

// Apply ------------------------------------------------------------------------------------------

/**
 * The HTTP precondition of `PUT /api/v1/admin/config`, exactly one (the route answers 428
 * without): `ifMatch` = the digest the client got as ETag (the SHA-256 hex of the stored bytes,
 * unquoted by the route), or `ifNoneMatch: "*"` for the first configuration.
 */
export type ConfigPrecondition =
  { ifMatch: string; ifNoneMatch?: never } | { ifNoneMatch: "*"; ifMatch?: never };

export type ApplyConfigResult =
  /** `sha256` of the bytes written: the new HTTP ETag. */
  | { config: Config; sha256: string }
  | { error: "precondition_failed" }
  | { error: "config_invalid"; details: { issues: ConfigIssue[] } };

// Lenient: a current config that is not JSON or not valid is still replaceable, it only cannot
// take part in V7 / V9.
function parseCurrent(bytes: Uint8Array): Config | undefined {
  try {
    const parsed = ConfigSchema.safeParse(decodeJson(bytes));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces config.json (plan §5.5). Reads config.json leniently (bytes and store ETag) and
 * catalog.json strictly (an invalid catalog throws), checks the precondition against the SHA-256
 * of the stored bytes (so a config that only an out-of-band write could have broken can still be
 * replaced, after a GET returned it as is), runs V1–V9 with the state rules on the catalog read
 * here, then writes the canonical bytes conditionally on the store ETag that was read
 * (`ifNoneMatch: "*"` for the first config). A lost write is precondition_failed, not retried.
 *
 * Only config.json is written. The catalog is not re-read before the write: a publish, retire or
 * certificate deletion in between is the accepted cross-object window (one operator at a time).
 */
export async function applyConfig(
  deps: { store: ObjectStore },
  body: unknown,
  precondition: ConfigPrecondition
): Promise<ApplyConfigResult> {
  const [stored, { catalog }] = await Promise.all([
    deps.store.get(CONFIG_KEY),
    readCatalog(deps.store),
  ]);
  const holds =
    precondition.ifNoneMatch === "*"
      ? stored === null
      : stored !== null && (await sha256Hex(stored.bytes)) === precondition.ifMatch;
  if (!holds) {
    return { error: "precondition_failed" };
  }

  const checked = validateConfig(body, {
    catalog,
    current: stored === null ? undefined : parseCurrent(stored.bytes),
  });
  if (!checked.ok) {
    return { error: "config_invalid", details: { issues: checked.issues } };
  }

  const bytes = encodeJson(checked.config);
  const written = await deps.store.put(CONFIG_KEY, bytes, {
    contentType: JSON_CONTENT_TYPE,
    ...(stored === null ? { ifNoneMatch: "*" } : { ifMatch: stored.etag }),
  });
  if (!written.ok) {
    return { error: "precondition_failed" };
  }
  return { config: checked.config, sha256: await sha256Hex(bytes) };
}
