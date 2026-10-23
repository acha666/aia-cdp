// config.json and catalog.json (plan §5.2, §5.3): schemas, the canonical format, reading and the
// conditional catalog write with retries. A value that is not in its canonical form (uppercase
// hex, a time without milliseconds, a misspelled key) is invalid, never normalized, so every reader
// can compare strings.
//
// There is no rebind ledger: the catalog only holds what the service imported and published.
import { z } from "zod";
import type { ObjectStore } from "./store.ts";

export const CONFIG_KEY = "config.json";
export const CATALOG_KEY = "catalog.json";

/** Content type of both JSON objects. */
export const JSON_CONTENT_TYPE = "application/json";

// Field formats ---------------------------------------------------------------------------------

/** Certificate id (SHA-256 of the DER) and CRL content digest: lowercase hex, 64 digits. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Expected lowercase hex SHA-256");

/** SHA-1 of the DER in a summary: lowercase hex, 40 digits. */
const Sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, "Expected lowercase hex SHA-1");

/**
 * Subject / Authority Key Identifier: lowercase hex, whole bytes; null when the extension (or the
 * AKI's keyIdentifier) is absent.
 */
const KeyId = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/, "Expected lowercase hex bytes")
  .nullable();

/** Uppercase hex of the INTEGER content bytes, leading 00 kept. */
const SerialNumber = z.string().regex(/^(?:[0-9A-F]{2})+$/, "Expected uppercase hex bytes");

/** Date.toISOString(): UTC with milliseconds, e.g. 2026-01-01T00:00:00.000Z. */
const Timestamp = z.iso.datetime({ precision: 3 });

/** CRL Number / Delta CRL base: decimal without leading zeros (compared as BigInt). */
const Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "Expected a decimal integer");

/** Target id: an RFC 9562 UUID (z.uuid() checks version and variant), lowercase. */
export const TargetId = z.uuid().regex(/^[0-9a-f-]+$/, "Expected a lowercase UUID");

export const CrlKind = z.enum(["full", "delta"]);
export type CrlKind = z.infer<typeof CrlKind>;

// config.json (operator) --------------------------------------------------------------------------

const ConfigCertificate = z.strictObject({ label: z.string() });

const ConfigTarget = z.strictObject({ issuer: Sha256Hex, kind: CrlKind, label: z.string() });

// The path rules (character set, prefix ↔ kind) are rules V2 / V3 of src/core/admin.ts, so that
// they are reported with their rule; the schema only fixes the shape.
const ConfigPath = z.union(
  [z.strictObject({ certificate: Sha256Hex }), z.strictObject({ target: TargetId })],
  { error: "Expected { certificate: <lowercase hex SHA-256> } or { target: <lowercase UUID> }" }
);

/**
 * config.json: the three maps are required and may be empty, so
 * `{"version":1,"certificates":{},"targets":{},"paths":{}}` is the smallest valid configuration.
 */
export const ConfigSchema = z
  .strictObject({
    version: z.literal(1),
    certificates: z.record(Sha256Hex, ConfigCertificate),
    targets: z.record(TargetId, ConfigTarget),
    paths: z.record(z.string(), ConfigPath),
  })
  .meta({ id: "Config" });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigTarget = z.infer<typeof ConfigTarget>;
export type ConfigPath = z.infer<typeof ConfigPath>;

// catalog.json (service) --------------------------------------------------------------------------

/** Built by buildCertificateSummary (src/core/summary/catalog-summary.ts). */
export const CertificateSummarySchema = z
  .strictObject({
    /** First CN in RDN order. */
    subjectCN: z.string().nullable(),
    issuerCN: z.string().nullable(),
    serialNumber: SerialNumber,
    notBefore: Timestamp,
    notAfter: Timestamp,
    subjectKeyId: KeyId,
    authorityKeyId: KeyId,
    sha1: Sha1Hex,
  })
  .meta({ id: "CertificateSummary" });

const CatalogCertificate = z.strictObject({
  /** certificateBlobKey(id). */
  key: z.string(),
  size: z.number().int().positive(),
  importedAt: Timestamp,
  summary: CertificateSummarySchema,
});

/** Built by buildCrlSummary (src/core/summary/catalog-summary.ts). */
export const CrlSummarySchema = z
  .strictObject({
    crlNumber: Decimal.nullable(),
    baseCrlNumber: Decimal.nullable(),
    thisUpdate: Timestamp,
    nextUpdate: Timestamp.nullable(),
    /**
     * Entries of revokedCertificates, 0 when the list is absent. Always known once published:
     * "unknown" is only a target without a current CRL.
     */
    revokedCount: z.number().int().nonnegative(),
    sha1: Sha1Hex,
    /** AD CS Next CRL Publish (1.3.6.1.4.1.311.21.4), null without the extension. */
    nextPublish: Timestamp.nullable(),
  })
  .meta({ id: "CrlSummary" });

const CurrentCrl = z.strictObject({
  sha256: Sha256Hex,
  key: z.string(),
  size: z.number().int().positive(),
  publishedAt: Timestamp,
  /** Id of the certificate that verified the signature. */
  verifier: Sha256Hex,
  summary: CrlSummarySchema,
});

const CatalogTarget = z.strictObject({ current: CurrentCrl.nullable() });

export const CatalogSchema = z
  .strictObject({
    version: z.literal(1),
    certificates: z.record(Sha256Hex, CatalogCertificate),
    targets: z.record(TargetId, CatalogTarget),
  })
  .meta({ id: "Catalog" });

export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogCertificate = z.infer<typeof CatalogCertificate>;
export type CurrentCrl = z.infer<typeof CurrentCrl>;

/** Store key of an imported certificate's DER (plan §5.1). */
export function certificateBlobKey(id: string): string {
  return `blobs/certificates/${id}.der`;
}

/** A fresh catalog with nothing imported or published (catalog.json is missing). */
export function emptyCatalog(): Catalog {
  return { version: 1, certificates: {}, targets: {} };
}

// Encoding --------------------------------------------------------------------------------------

/** The canonical bytes of config.json / catalog.json: two-space indent, trailing newline. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** UTF-8 JSON, a leading BOM skipped. Throws on bytes that are not UTF-8 or not JSON. */
export function decodeJson(bytes: Uint8Array): unknown {
  // Both options spelled out: the Workers types declare them as required.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

/**
 * config.json or catalog.json in the store is not JSON or does not match its schema. Only an
 * out-of-band write produces this; the service never overwrites such an object on its own (the
 * request fails with 500 and the error goes to the log).
 */
export class InvalidStoredObjectError extends Error {
  override name = "InvalidStoredObjectError";
  readonly key: string;

  constructor(key: string, options?: ErrorOptions) {
    super(`${key} in the store is invalid`, options);
    this.key = key;
  }
}

function parseStored<T>(key: string, bytes: Uint8Array, schema: z.ZodType<T>): T {
  try {
    return schema.parse(decodeJson(bytes));
  } catch (error) {
    throw new InvalidStoredObjectError(key, { cause: error });
  }
}

// Reading ---------------------------------------------------------------------------------------

/** catalog.json and its store ETag; a missing catalog is empty with etag null. */
export async function readCatalog(
  store: ObjectStore
): Promise<{ catalog: Catalog; etag: string | null }> {
  const object = await store.get(CATALOG_KEY);
  if (object === null) {
    return { catalog: emptyCatalog(), etag: null };
  }
  return { catalog: parseStored(CATALOG_KEY, object.bytes, CatalogSchema), etag: object.etag };
}

export interface State {
  /** null while config.json is missing (nothing configured yet). */
  config: Config | null;
  catalog: Catalog;
  catalogEtag: string | null;
}

/**
 * One `get` each of config.json and catalog.json. Throws InvalidStoredObjectError when either is
 * present but not valid; store errors propagate. The catalog ETag is the store's (opaque).
 */
export async function readState(store: ObjectStore): Promise<State> {
  const [configObject, { catalog, etag: catalogEtag }] = await Promise.all([
    store.get(CONFIG_KEY),
    readCatalog(store),
  ]);
  const config =
    configObject === null ? null : parseStored(CONFIG_KEY, configObject.bytes, ConfigSchema);
  return { config, catalog, catalogEtag };
}

// Conditional catalog write ---------------------------------------------------------------------

/** Waits before each retry of a lost catalog write (plan §5.5: 1 attempt + 3 retries). */
const BACKOFF_MS = [250, 500, 1000];

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a mutation decided: write `next` and return `result`, or return `result` without a write. */
export type CatalogMutation<R> = { next: Catalog; result: R } | { result: R };

/**
 * Read-modify-write of catalog.json under the store's precondition. Every attempt starts with
 * readState, and the catalog write is conditional on the catalog ETag of that read (`ifMatch`, or
 * `ifNoneMatch: "*"` while the catalog is missing). `mutate` must derive `next` from the state it
 * is given: on a lost race (precondition-failed) it runs again on the re-read state after the next
 * backoff, so whatever the other writer added is kept. It may be async and may write other objects
 * before it returns `next`, as long as those writes are create-only: they stay when the catalog
 * write is lost. A mutation without `next` ends the loop without a write. After 1 + 3 lost
 * attempts → concurrent_update. `sleep` is injected so tests do not wait.
 *
 * A throwing `put` is not retried (it may have taken effect, and R2's per-key write rate limit is
 * not a precondition failure); neither is an invalid `next`, which throws instead of being written.
 * An invalid stored config.json or catalog.json throws InvalidStoredObjectError.
 */
export async function updateState<R>(
  store: ObjectStore,
  mutate: (state: State) => CatalogMutation<R> | Promise<CatalogMutation<R>>,
  sleep: (ms: number) => Promise<void> = realSleep
): Promise<{ result: R } | { error: "concurrent_update" }> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const wait = BACKOFF_MS[attempt - 1];
    if (wait !== undefined) {
      await sleep(wait);
    }
    const state = await readState(store);
    const mutation = await mutate(state);
    if (!("next" in mutation)) {
      return { result: mutation.result };
    }
    const next = CatalogSchema.parse(mutation.next);
    const written = await store.put(CATALOG_KEY, encodeJson(next), {
      contentType: JSON_CONTENT_TYPE,
      ...(state.catalogEtag === null ? { ifNoneMatch: "*" } : { ifMatch: state.catalogEtag }),
    });
    if (written.ok) {
      return { result: mutation.result };
    }
  }
  return { error: "concurrent_update" };
}
