// Certificate import (plan §5.5).
// There is one commit point, the catalog write: no companion objects, no edge cache. Importing does
// not authorize anything: a certificate only becomes an issuer once a config target names it.
import { certificateBlobKey, readCatalog, updateState } from "./catalog.ts";
import type { CatalogCertificate, CertificateSummary } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { parseCertificate, sameSignatureAlgorithms } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import type { ObjectStore } from "./store.ts";
import { buildCertificateSummary } from "./summary/catalog-summary.ts";

export interface ImportDeps {
  store: ObjectStore;
  now: () => Date;
  /** Backoff between catalog write attempts; a timer when omitted. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ImportedCertificate {
  outcome: "created" | "unchanged";
  /** SHA-256 of the DER. */
  id: string;
  entry: CatalogCertificate;
}

export type ImportResult =
  | ImportedCertificate
  | { error: "invalid_certificate"; details: { reason: PkiParseReason } }
  | { error: "concurrent_update"; id: string };

/** The DER blob is written with this type (R2 keeps it as httpMetadata). */
const CERTIFICATE_CONTENT_TYPE = "application/pkix-cert";

/**
 * Imports one certificate (DER or a single PEM block; the format is recognized from the bytes).
 * The id is the SHA-256 of the DER. Already in the catalog → `unchanged` with the stored entry and
 * no write. Otherwise the blob is written create-only (an existing blob has the same bytes: the
 * key is the digest) and the entry added by updateState, which checks again for the id on every
 * attempt, so two concurrent imports of one certificate end as one `created` and one `unchanged`.
 *
 * Any rejection happens before the first write. If the catalog write is lost (concurrent_update)
 * or the process dies after the blob write, only an unreferenced blob remains; certificates are
 * listed from the catalog, so it stays invisible.
 */
export async function importCertificate(
  deps: ImportDeps,
  bytes: Uint8Array
): Promise<ImportResult> {
  const now = deps.now();
  // toDer → parseCertificate (strict DER, RFC 5280 times) → the two signature algorithms →
  // summary; every PkiParseError is a 422. The outer signatureAlgorithm must be the TBS signature,
  // octet for octet as received (RFC 5280 §4.1.1.2): it is outside the signature, and the detail
  // shows it.
  let der: Uint8Array;
  let summary: CertificateSummary;
  try {
    der = toDer(bytes, "certificate");
    const certificate = parseCertificate(der);
    if (!sameSignatureAlgorithms(certificate)) {
      return { error: "invalid_certificate", details: { reason: "signature_algorithm_mismatch" } };
    }
    summary = await buildCertificateSummary(certificate, der);
  } catch (error) {
    if (error instanceof PkiParseError) {
      return { error: "invalid_certificate", details: { reason: error.reason } };
    }
    throw error;
  }
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
  const update = await updateState<Omit<ImportedCertificate, "id">>(
    deps.store,
    ({ catalog: current }) => {
      const raced = current.certificates[id];
      if (raced !== undefined) {
        return { result: { outcome: "unchanged", entry: raced } };
      }
      return {
        next: { ...current, certificates: { ...current.certificates, [id]: entry } },
        result: { outcome: "created", entry },
      };
    },
    deps.sleep
  );
  if ("error" in update) {
    return { error: update.error, id };
  }
  return { ...update.result, id };
}
