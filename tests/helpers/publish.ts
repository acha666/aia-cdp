// State and calls for the publish tests: certificates imported with importCertificate and targets
// applied with applyConfig, as an operator would, on any store; publishCrl at NOW with a recording
// sleep.
import { applyConfig } from "../../src/core/admin.ts";
import { CATALOG_KEY, ConfigSchema } from "../../src/core/catalog.ts";
import type { Config, CrlKind } from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/import.ts";
import { publishCrl } from "../../src/core/publish.ts";
import type { PublishLogRecord, PublishResult } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import { patchStore } from "./app.ts";
import { cert } from "./catalog.ts";

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
export const ISSUING_FULL_ALIAS = "/crl/issuing-ca-1-alias.crl";

/** The path of a target: `/crl/<issuer>.crl` (full) or `/dcrl/<issuer>.crl` (delta). */
export function targetPath({ issuer, kind }: TargetSpec): string {
  return `/${kind === "full" ? "crl" : "dcrl"}/${issuer}.crl`;
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

/** Imports the certificates, then applies the first config.json (If-None-Match: *). */
export async function setupPublish(
  store: ObjectStore,
  { certificates = IMPORTED, targets = DEFAULT_TARGETS, configure }: SetupOptions = {}
): Promise<PublishSetup> {
  for (const name of certificates) {
    const imported = await importCertificate({ store, now: () => NOW }, fixture(cert(name).der));
    if (!("outcome" in imported)) {
      throw new Error(`import ${name}: ${imported.error}`);
    }
  }
  const ids = new Map<string, string>();
  const config: Config = { version: 1, certificates: {}, targets: {}, paths: {} };
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
  const applied = await applyConfig({ store }, ConfigSchema.parse(config), { ifNoneMatch: "*" });
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

/**
 * `base`, except that `rival` runs right before the first catalog.json put is forwarded: a
 * concurrent publish that lands between this call's state read and its catalog write.
 */
export function racingStore(base: ObjectStore, rival: () => Promise<unknown>): ObjectStore {
  let raced = false;
  return patchStore(
    {
      put: async (key, bytes, opts) => {
        if (key === CATALOG_KEY && !raced) {
          raced = true;
          await rival();
        }
        return base.put(key, bytes, opts);
      },
    },
    base
  );
}
