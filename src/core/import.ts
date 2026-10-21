// Certificate import (plan §5.5, implementation slice 2 step 5; §10 #5, #14; M1, M9, M23).
// There is one commit point, the catalog write: no companion objects, no edge cache. Importing does
// not authorize anything: a certificate only becomes an issuer once a config target names it.
import {
  CertificateSummarySchema,
  certificateBlobKey,
  readCatalog,
  realSleep,
  updateCatalog,
} from "./catalog.ts";
import type { CatalogCertificate } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { parseCertificate, sameSignatureAlgorithms } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import type { ObjectStore } from "./store.ts";
import { buildCertificateSummary } from "./summary/catalog-summary.ts";
import type { CertificateSummary } from "./summary/catalog-summary.ts";

export interface ImportDeps {
  store: ObjectStore;
  now: () => Date;
  /** Backoff between catalog write attempts; realSleep when omitted. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ImportedCertificate {
  outcome: "created" | "unchanged";
  /** SHA-256 of the DER. */
  id: string;
  entry: CatalogCertificate;
}

/** The details.reason of invalid_certificate (implementation §2.6). */
export type InvalidCertificateReason = PkiParseReason | "signature_algorithm_mismatch";

export type ImportResult =
  | ImportedCertificate
  | { error: "invalid_certificate"; details: { reason: InvalidCertificateReason } }
  | { error: "concurrent_update"; id: string };

/** The DER blob is written with this type (R2 keeps it as httpMetadata). */
const CERTIFICATE_CONTENT_TYPE = "application/pkix-cert";

interface Parsed {
  der: Uint8Array;
  summary: CertificateSummary;
}

// toDer → parseCertificate (strict DER, RFC 5280 times) → the two signature algorithms → summary;
// every PkiParseError is a 422. The outer signatureAlgorithm must be the TBS signature, octet for
// octet as received (RFC 5280 §4.1.1.2; the same comparison as the CRL upload policy, M11): it is
// outside the signature, and the detail shows it (slice 5a review). The summary is checked against
// the catalog format here, before the blob write: a value the catalog cannot hold would otherwise
// only fail in updateCatalog, after it (a 500 and a blob).
async function parse(bytes: Uint8Array): Promise<Parsed | { reason: InvalidCertificateReason }> {
  try {
    const der = toDer(bytes, "certificate");
    const certificate = parseCertificate(der);
    if (!sameSignatureAlgorithms(certificate)) {
      return { reason: "signature_algorithm_mismatch" };
    }
    const summary = await buildCertificateSummary(certificate, der);
    if (!CertificateSummarySchema.safeParse(summary).success) {
      // No catalog form for the summary.
      return { reason: "structure" };
    }
    return { der, summary };
  } catch (error) {
    if (error instanceof PkiParseError) {
      return { reason: error.reason };
    }
    throw error;
  }
}

/**
 * Imports one certificate (DER or a single PEM block; the format is recognized from the bytes).
 * The id is the SHA-256 of the DER. Already in the catalog → `unchanged` with the stored entry and
 * no write. Otherwise the blob is written create-only (an existing blob has the same bytes: the
 * key is the digest) and the entry added by updateCatalog, which checks again for the id on every
 * attempt, so two concurrent imports of one certificate end as one `created` and one `unchanged`.
 *
 * Any rejection happens before the first write (M9). If the catalog write is lost
 * (concurrent_update) or the process dies after the blob write, only an unreferenced blob remains;
 * certificates are listed from the catalog, so it stays invisible (C8).
 */
export async function importCertificate(
  deps: ImportDeps,
  bytes: Uint8Array
): Promise<ImportResult> {
  const now = deps.now();
  const parsed = await parse(bytes);
  if ("reason" in parsed) {
    return { error: "invalid_certificate", details: { reason: parsed.reason } };
  }
  const { der, summary } = parsed;
  const id = await sha256Hex(der);

  const { catalog } = await readCatalog(deps.store);
  const existing = catalog.certificates[id];
  if (existing !== undefined) {
    return { outcome: "unchanged", id, entry: existing };
  }

  const key = certificateBlobKey(id);
  // precondition-failed: the blob is already there with these very bytes.
  await deps.store.put(key, der, { ifNoneMatch: "*", contentType: CERTIFICATE_CONTENT_TYPE });

  const entry: CatalogCertificate = {
    key,
    size: der.byteLength,
    importedAt: now.toISOString(),
    summary,
  };
  const update = await updateCatalog<Omit<ImportedCertificate, "id">>(
    deps.store,
    (current) => {
      const raced = current.certificates[id];
      if (raced !== undefined) {
        return { result: { outcome: "unchanged", entry: raced } };
      }
      return {
        next: { ...current, certificates: { ...current.certificates, [id]: entry } },
        result: { outcome: "created", entry },
      };
    },
    { sleep: deps.sleep ?? realSleep }
  );
  if ("error" in update) {
    return { error: update.error, id };
  }
  return { ...update.result, id };
}
