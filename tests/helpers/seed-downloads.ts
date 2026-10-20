// A served state for the download tests (implementation slice 3): the DER blobs, catalog.json and
// config.json written straight into any ObjectStore (MemoryStore for tests/http, the fs adapter
// for tests/integration), so the HTTP, Node and Worker tests serve the same data. Certificates go
// through slice 2's summary builder (certificateEntry), both documents through its schemas; the
// CRL `current` records are written directly, since publishing is slice 4. Every digest, size and
// time comes from the fixtures (implementation §2.5).
import { CatalogSchema, ConfigSchema } from "../../src/core/catalog.ts";
import type { Catalog, Config, CrlKind } from "../../src/core/catalog.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import { cert, certificateEntry, currentCrl, putCatalog, putConfig } from "./catalog.ts";

/** The path table of the seed. */
export const DOWNLOAD_PATHS = {
  /** root-ca; also served as rootAlias and nested (three paths, one certificate). */
  root: "/ca/root-ca.crt",
  rootAlias: "/ca/root.cer",
  /** Two segments under /ca/ (V2 allows that): `%2F` must not reach it (M20). */
  nested: "/ca/sub/root-ca.crt",
  issuing: "/ca/issuing-ca-1.crt",
  /** issuing-ca-1's full CRL target; current: options.full. */
  full: "/crl/issuing-ca-1.crl",
  /** issuing-ca-1's delta CRL target; current: options.delta. */
  delta: "/dcrl/issuing-ca-1.crl",
  /** root-ca's full CRL target, never published (no catalog entry). */
  unpublished: "/crl/root-ca.crl",
  /** issuing-ca-2's full CRL target, retired (current null). */
  retired: "/crl/issuing-ca-2.crl",
} as const;

/** CRL fixtures of issuing-ca-1 for the full and the delta target. */
export const SEED_CRLS = {
  /** nextUpdate 4 days after NOW: max-age 3600. */
  full: "crls/issuing-ca-1/full-01.der",
  /** Expired at NOW: max-age 60. */
  delta: "crls/issuing-ca-1/delta-01.der",
  /** A full CRL without nextUpdate: max-age 300. */
  fullWithoutNextUpdate: "crls/issuing-ca-1/full-no-next-update.der",
} as const;

const HOUR = 3_600_000;

export interface DownloadSeedOptions {
  /** The full target's current CRL, a full CRL of issuing-ca-1 (default SEED_CRLS.full). */
  full?: string;
  /** The delta target's current CRL, a delta CRL of issuing-ca-1 (default SEED_CRLS.delta). */
  delta?: string;
  /** importedAt of every certificate. Default: 50 h before NOW, with milliseconds to drop. */
  importedAt?: Date;
  /** publishedAt of both current CRLs. Default: 2 h before NOW, with milliseconds. */
  publishedAt?: Date;
}

export interface DownloadSeed {
  config: Config;
  catalog: Catalog;
  /** Target ids by role (fresh UUIDs on every build). */
  targets: { full: string; delta: string; unpublished: string; retired: string };
  /** Every DER blob the catalog names, by store key: three certificates and two CRLs. */
  blobs: Map<string, SeedBlob>;
}

export interface SeedBlob {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: "application/pkix-cert" | "application/pkix-crl";
}

function issuingCrl(file: string, kind: CrlKind): string {
  const entry = manifest.crls.find((crl) => crl.file === file);
  if (entry?.issuer !== "issuing-ca-1" || entry.kind !== kind) {
    throw new Error(`${file} is not a ${kind} CRL of issuing-ca-1`);
  }
  return file;
}

/** The seed's documents and blobs, without writing them. */
export async function buildDownloadSeed(options: DownloadSeedOptions = {}): Promise<DownloadSeed> {
  const full = issuingCrl(options.full ?? SEED_CRLS.full, "full");
  const delta = issuingCrl(options.delta ?? SEED_CRLS.delta, "delta");
  const importedAt = options.importedAt ?? new Date(NOW.getTime() - 50 * HOUR - 250);
  const publishedAt = options.publishedAt ?? new Date(NOW.getTime() - 2 * HOUR - 750);
  const root = cert("root-ca");
  const issuing = cert("issuing-ca-1");
  const issuing2 = cert("issuing-ca-2");
  const targets = {
    full: crypto.randomUUID(),
    delta: crypto.randomUUID(),
    unpublished: crypto.randomUUID(),
    retired: crypto.randomUUID(),
  };

  const blobs = new Map<string, SeedBlob>();
  const certificates: Catalog["certificates"] = {};
  for (const ca of [root, issuing, issuing2]) {
    const { id, entry } = await certificateEntry(ca.name, importedAt);
    certificates[id] = entry;
    blobs.set(entry.key, { bytes: fixture(ca.der), contentType: "application/pkix-cert" });
  }
  const current = (file: string, target: string) => {
    const record = { ...currentCrl(file, target), publishedAt: publishedAt.toISOString() };
    blobs.set(record.key, { bytes: fixture(file), contentType: "application/pkix-crl" });
    return record;
  };

  const catalog = CatalogSchema.parse({
    version: 1,
    certificates,
    targets: {
      [targets.full]: { current: current(full, targets.full) },
      [targets.delta]: { current: current(delta, targets.delta) },
      [targets.retired]: { current: null },
    },
  });
  const config = ConfigSchema.parse({
    version: 1,
    certificates: {
      [root.sha256]: { label: "Root CA" },
      [issuing.sha256]: { label: "Issuing CA 1" },
      [issuing2.sha256]: { label: "Issuing CA 2" },
    },
    targets: {
      [targets.full]: { issuer: issuing.sha256, kind: "full", label: "Issuing CA 1" },
      [targets.delta]: { issuer: issuing.sha256, kind: "delta", label: "Issuing CA 1 (delta)" },
      [targets.unpublished]: { issuer: root.sha256, kind: "full", label: "Root CA" },
      [targets.retired]: { issuer: issuing2.sha256, kind: "full", label: "Issuing CA 2" },
    },
    paths: {
      [DOWNLOAD_PATHS.root]: { certificate: root.sha256 },
      [DOWNLOAD_PATHS.rootAlias]: { certificate: root.sha256 },
      [DOWNLOAD_PATHS.nested]: { certificate: root.sha256 },
      [DOWNLOAD_PATHS.issuing]: { certificate: issuing.sha256 },
      [DOWNLOAD_PATHS.full]: { target: targets.full },
      [DOWNLOAD_PATHS.delta]: { target: targets.delta },
      [DOWNLOAD_PATHS.unpublished]: { target: targets.unpublished },
      [DOWNLOAD_PATHS.retired]: { target: targets.retired },
    },
  });
  return { config, catalog, targets, blobs };
}

/**
 * Writes the seed into `store` as the service would leave it: blobs first, then catalog.json, then
 * config.json. Returns what was written.
 */
export async function seedDownloads(
  store: ObjectStore,
  options: DownloadSeedOptions = {}
): Promise<DownloadSeed> {
  const seed = await buildDownloadSeed(options);
  for (const [key, { bytes, contentType }] of seed.blobs) {
    const result = await store.put(key, bytes, { contentType });
    if (!result.ok) {
      throw new Error(`put ${key}: ${result.reason}`);
    }
  }
  await putCatalog(store, seed.catalog);
  await putConfig(store, seed.config);
  return seed;
}
