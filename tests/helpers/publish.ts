// State and calls for the publish tests: certificates imported with importCertificate and targets
// applied with applyConfig, as an operator would, on any store; publishCrl at NOW with a recording
// sleep.
import { applyConfig } from "../../src/core/admin.ts";
import type { ApplyConfigResult, ConfigPrecondition } from "../../src/core/admin.ts";
import { CONFIG_KEY, emptyConfig } from "../../src/core/catalog.ts";
import type { Config, CrlKind } from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/certificates.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { publishCrl } from "../../src/core/publish.ts";
import type { CurrentVersion, PublishLogRecord, PublishResult } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { cert, crlEntry, fixture, manifest, NOW } from "../fixtures/pki.ts";

export interface TargetSpec {
  /** Certificate name (manifest.certificates[].name) of the target's issuer. */
  issuer: string;
  kind: CrlKind;
}

/** Every certificate the manifest marks `import: true`. */
export const IMPORTED: readonly string[] = manifest.certificates
  .filter((certificate) => certificate.import)
  .map((certificate) => certificate.name);

/** issuing-ca-1 and -2 full + delta, root-ca, ed25519-ca and ed448-ca full. */
export const DEFAULT_TARGETS: readonly TargetSpec[] = [
  { issuer: "issuing-ca-1", kind: "full" },
  { issuer: "issuing-ca-1", kind: "delta" },
  { issuer: "issuing-ca-2", kind: "full" },
  { issuer: "issuing-ca-2", kind: "delta" },
  { issuer: "root-ca", kind: "full" },
  { issuer: "ed25519-ca", kind: "full" },
  { issuer: "ed448-ca", kind: "full" },
];

/**
 * A second path of issuing-ca-1's full target, added whenever that target is configured. It sorts
 * before `/crl/issuing-ca-1.crl` ("-" < "."), the reverse of the insertion order.
 */
const ISSUING_FULL_ALIAS = "/crl/issuing-ca-1-alias.crl";

/** The path of a target: `/crl/<issuer>.crl` (full) or `/dcrl/<issuer>.crl` (delta). */
function targetPath({ issuer, kind }: TargetSpec): string {
  return `/${kind === "full" ? "crl" : "dcrl"}/${issuer}.crl`;
}

/** The download paths of a target of the shared setup (ISSUING_FULL_ALIAS sorts first). */
export function downloadsOf(issuer: string, kind: CrlKind): string[] {
  const path = targetPath({ issuer, kind });
  const paths = issuer === "issuing-ca-1" && kind === "full" ? [ISSUING_FULL_ALIAS, path] : [path];
  return paths.flatMap((each) => [each, `${each}.pem`]);
}

export interface PublishSetup {
  config: Config;
  /** The id of the target of `issuer` (certificate name) and `kind`; throws without one. */
  target(issuer: string, kind: CrlKind): string;
}

export interface SetupOptions {
  /** Certificate names to import (default IMPORTED). */
  certificates?: readonly string[];
  /** Default DEFAULT_TARGETS; each gets a fresh UUID and targetPath. */
  targets?: readonly TargetSpec[];
  /** Edits config.json before it is applied (certificate labels, more paths). */
  configure?: (config: Config) => void;
}

/** importCertificate at NOW; the certificate's id. Throws on a rejection. */
export async function importOrThrow(store: ObjectStore, bytes: Uint8Array): Promise<string> {
  const imported = await importCertificate({ store, now: () => NOW }, bytes);
  if (!("outcome" in imported)) {
    throw new Error(`import: ${imported.error}`);
  }
  return imported.id;
}

/**
 * applyConfig with the precondition an operator sends: If-None-Match: * while config.json is
 * missing, otherwise If-Match with the SHA-256 of its stored bytes.
 */
export async function applyOver(store: ObjectStore, config: unknown): Promise<ApplyConfigResult> {
  const stored = await store.get(CONFIG_KEY);
  const precondition: ConfigPrecondition =
    stored === null ? { ifNoneMatch: "*" } : { ifMatch: await sha256Hex(stored.bytes) };
  return applyConfig({ store }, config, precondition);
}

/** `details.current` of a 409 against the CRL fixture `file` (a .der) as the current CRL. */
export function versionOf(file: string): CurrentVersion {
  const { sha256, crlNumber, thisUpdate } = crlEntry(file);
  return { sha256, crlNumber, thisUpdate: new Date(thisUpdate).toISOString() };
}

/** Imports the certificates, then applies config.json over the store's (the first on a new store). */
export async function setupPublish(
  store: ObjectStore,
  { certificates = IMPORTED, targets = DEFAULT_TARGETS, configure }: SetupOptions = {}
): Promise<PublishSetup> {
  for (const name of certificates) {
    await importOrThrow(store, fixture(cert(name).der));
  }
  const ids = new Map<string, string>();
  const config = emptyConfig();
  for (const spec of targets) {
    const id = crypto.randomUUID();
    ids.set(`${spec.issuer}/${spec.kind}`, id);
    config.targets[id] = {
      issuer: cert(spec.issuer).sha256,
      kind: spec.kind,
      label: `${spec.issuer} ${spec.kind}`,
    };
    config.paths[targetPath(spec)] = { target: id };
    if (spec.issuer === "issuing-ca-1" && spec.kind === "full") {
      config.paths[ISSUING_FULL_ALIAS] = { target: id };
    }
  }
  configure?.(config);
  const applied = await applyOver(store, config);
  if ("error" in applied) {
    throw new Error(`applyConfig: ${JSON.stringify(applied)}`);
  }
  return {
    config: applied.config,
    target(issuer, kind) {
      const id = ids.get(`${issuer}/${kind}`);
      if (id === undefined) {
        throw new Error(`no ${kind} target of ${issuer} in this setup`);
      }
      return id;
    },
  };
}

export interface PublishRun {
  result: PublishResult;
  /** The call's log record: publishCrl must log exactly one, or publish() throws. */
  record: PublishLogRecord;
  /** Every backoff the call asked for, in order. */
  sleeps: number[];
}

/** publishCrl with NOW, a recording sleep and a collecting log. */
export async function publish(store: ObjectStore, bytes: Uint8Array): Promise<PublishRun> {
  const records: PublishLogRecord[] = [];
  const sleeps: number[] = [];
  const result = await publishCrl(
    {
      store,
      now: () => new Date(NOW),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (record) => {
        records.push(record);
      },
    },
    bytes
  );
  const [record, ...more] = records;
  if (record === undefined || more.length > 0) {
    throw new Error(`publishCrl logged ${records.length} records instead of one`);
  }
  return { result, record, sleeps };
}

/** publish() of a fixture file (relative to tests/fixtures/pki/). */
export function publishFile(store: ObjectStore, file: string): Promise<PublishRun> {
  return publish(store, fixture(file));
}
