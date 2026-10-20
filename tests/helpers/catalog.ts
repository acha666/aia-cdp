// Catalog values built from the fixtures (implementation §2.5: digests, key ids and sizes come from
// the files or manifest.json, never from literals).
import { createHash } from "node:crypto";
import type { Catalog, CatalogCertificate, Config, CurrentCrl } from "../../src/core/catalog.ts";
import { CATALOG_KEY, certificateBlobKey, CONFIG_KEY, encodeJson } from "../../src/core/catalog.ts";
import { parseCertificate } from "../../src/core/pki/parsers.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { buildCertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import type { ManifestCertificate, ManifestCrl } from "../fixtures/pki.ts";

/** The manifest entry of a certificate fixture (certs/<name>.der). */
export function cert(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest certificate ${name}`);
  }
  return found;
}

function crl(file: string): ManifestCrl {
  const found = manifest.crls.find((c) => c.file === file);
  if (!found) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found;
}

/** The catalog entry importCertificate writes for certs/<name>.der at `importedAt`. */
export async function certificateEntry(
  name: string,
  importedAt: Date = NOW
): Promise<{ id: string; entry: CatalogCertificate }> {
  const { der: path, sha256: id } = cert(name);
  const der = fixture(path);
  return {
    id,
    entry: {
      key: certificateBlobKey(id),
      size: der.byteLength,
      importedAt: importedAt.toISOString(),
      summary: await buildCertificateSummary(parseCertificate(der), der),
    },
  };
}

/**
 * A `current` record for a CRL fixture, verified by its issuer. Only the catalog format matters
 * here (the blob is not written); slice 4's publishCrl produces the real thing.
 */
export function currentCrl(file: string, targetId: string): CurrentCrl {
  const entry = crl(file);
  const der = fixture(file);
  const iso = (value: string) => new Date(value).toISOString();
  return {
    sha256: entry.sha256,
    key: `blobs/crls/${targetId}/${entry.sha256}.der`,
    size: der.byteLength,
    publishedAt: NOW.toISOString(),
    verifier: cert(entry.issuer).sha256,
    summary: {
      crlNumber: entry.crlNumber,
      baseCrlNumber: entry.baseCrlNumber,
      thisUpdate: iso(entry.thisUpdate),
      nextUpdate: entry.nextUpdate === null ? null : iso(entry.nextUpdate),
      revokedCount: entry.revoked,
      sha1: createHash("sha1").update(der).digest("hex"),
    },
  };
}

/** Writes catalog.json in the canonical format, unconditionally. */
export async function putCatalog(store: ObjectStore, catalog: Catalog): Promise<void> {
  const result = await store.put(CATALOG_KEY, encodeJson(catalog));
  if (!result.ok) {
    throw new Error(`put ${CATALOG_KEY}: ${result.reason}`);
  }
}

/** Writes config.json in the canonical format, unconditionally (no V1–V9, unlike applyConfig). */
export async function putConfig(store: ObjectStore, config: Config): Promise<void> {
  const result = await store.put(CONFIG_KEY, encodeJson(config));
  if (!result.ok) {
    throw new Error(`put ${CONFIG_KEY}: ${result.reason}`);
  }
}
