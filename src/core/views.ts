// The read model of the public API (plan §5.6, §7.1): certificate and CRL target lists, their
// details and the stats, built from config.json and catalog.json (one `get` each per request,
// through readState in ./catalog.ts); a detail also reads the one blob it shows. Their shapes are
// the response schemas of src/http/schemas.ts, against which the routes type-check every view.
// Ids and kinds come from the catalog and config, never from a store key, and a store key never
// appears in a view.
//
// Lists are complete arrays (no pagination), certificates in id order and targets in targetId
// order (code units; the UI sorts for display).
//
// What the catalog and config name but the store cannot back throws, and the HTTP layer answers
// its generic 500: never a 404, an empty list or a partial 200.
import type { BitString } from "asn1js";
import type * as pkijs from "pkijs";
import type { Catalog, CatalogCertificate, Config } from "./catalog.ts";
import { SIGNATURE_ALG_NAMES } from "./pki/constants.ts";
import { parseCertificate, parseCRL } from "./pki/parsers.ts";
import { downloadPaths } from "./resources.ts";
import type { ObjectStore } from "./store.ts";
import { buildTBSCertificate } from "./summary/certificate.ts";
import { buildTBSCertList } from "./summary/crl.ts";
import {
  buildAlgorithmIdentifier,
  buildFingerprints,
  buildSignatureValue,
} from "./summary/primitives.ts";
import type { AlgorithmIdentifier, SignatureValue } from "./summary/schemas.ts";

// Helpers -----------------------------------------------------------------------------------------

/** Keys in code-unit order. */
function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

/**
 * The blob at `key` with its fingerprints, when it is the DER whose SHA-256 the catalog records: a
 * missing blob or one with another digest throws. Checked before parsing, so a detail never shows
 * other bytes under the catalog's id.
 */
async function checkedBlob(store: ObjectStore, key: string, sha256: string) {
  const blob = await store.get(key);
  if (blob === null) {
    throw new Error(`The store has no blob ${key}`);
  }
  const fingerprints = await buildFingerprints(blob.bytes);
  if (fingerprints.sha256 !== sha256) {
    throw new Error(`Blob ${key} does not have the catalog's SHA-256`);
  }
  return { der: blob.bytes, fingerprints };
}

/**
 * The outer signatureAlgorithm (with its parameters) and signatureValue of a certificate or CRL:
 * required in both details.
 */
function signature(signed: {
  signatureAlgorithm: pkijs.AlgorithmIdentifier;
  signatureValue: BitString;
}): { signatureAlgorithm: AlgorithmIdentifier; signatureValue: SignatureValue } {
  const algorithm = signed.signatureAlgorithm;
  return {
    signatureAlgorithm: buildAlgorithmIdentifier(algorithm, SIGNATURE_ALG_NAMES),
    signatureValue: buildSignatureValue(signed.signatureValue, algorithm.algorithmId),
  };
}

// Certificates ------------------------------------------------------------------------------------

function certificateItem(config: Config, id: string, entry: CatalogCertificate) {
  const targets = sortedKeys(config.targets).flatMap((targetId) => {
    const target = config.targets[targetId];
    return target?.issuer === id ? [{ targetId, kind: target.kind, label: target.label }] : [];
  });
  return {
    id,
    label: config.certificates[id]?.label ?? null,
    importedAt: entry.importedAt,
    size: entry.size,
    summary: entry.summary,
    downloads: downloadPaths(config, { certificate: id }),
    targets,
  };
}

/** GET /api/v1/certificates: one item per catalog certificate, in id order. */
export function certificateList(config: Config, catalog: Catalog) {
  return sortedKeys(catalog.certificates).flatMap((id) => {
    const entry = catalog.certificates[id];
    return entry === undefined ? [] : [certificateItem(config, id, entry)];
  });
}

/**
 * GET /api/v1/certificates/{id}: the list item plus fingerprints, TBSCertificate, signature
 * algorithm (with its parameters) and signature value of the stored DER; undefined when the
 * catalog has no certificate `id` (lowercase hex). Throws for a missing blob, other bytes or a blob
 * that does not parse.
 */
export async function certificateDetail(
  store: ObjectStore,
  config: Config,
  catalog: Catalog,
  id: string
) {
  const entry = catalog.certificates[id];
  if (entry === undefined) {
    return undefined;
  }
  const blob = await checkedBlob(store, entry.key, id);
  const certificate = parseCertificate(blob.der);
  return {
    ...certificateItem(config, id, entry),
    fingerprints: blob.fingerprints,
    tbsCertificate: await buildTBSCertificate(certificate),
    ...signature(certificate),
  };
}

// CRL targets -------------------------------------------------------------------------------------

function crlTargetItem(config: Config, catalog: Catalog, targetId: string) {
  const target = config.targets[targetId];
  if (target === undefined) {
    return undefined;
  }
  const issuer = catalog.certificates[target.issuer];
  if (issuer === undefined) {
    throw new Error(
      `Target ${targetId} names issuer ${target.issuer}, which is not in the catalog`
    );
  }
  const current = catalog.targets[targetId]?.current ?? null;
  return {
    targetId,
    kind: target.kind,
    label: target.label,
    issuer: {
      id: target.issuer,
      label: config.certificates[target.issuer]?.label ?? null,
      subjectCN: issuer.summary.subjectCN,
    },
    downloads: downloadPaths(config, { target: targetId }),
    current:
      current === null
        ? null
        : {
            sha256: current.sha256,
            size: current.size,
            publishedAt: current.publishedAt,
            summary: current.summary,
          },
  };
}

/**
 * GET /api/v1/crls: one item per configured target, in targetId order. A catalog current whose
 * target config.json no longer defines is not listed (no kind, no paths).
 */
export function crlTargetList(config: Config, catalog: Catalog) {
  return sortedKeys(config.targets).flatMap(
    (targetId) => crlTargetItem(config, catalog, targetId) ?? []
  );
}

/**
 * GET /api/v1/crls/{targetId}: the list item, and for a published target its current CRL with
 * verifier, fingerprints, TBSCertList (every revoked entry), signature algorithm and value of the
 * stored DER (an unpublished target reads no blob); undefined when config.json defines no target
 * `targetId` (lowercase). Throws like certificateDetail.
 */
export async function crlTargetDetail(
  store: ObjectStore,
  config: Config,
  catalog: Catalog,
  targetId: string
) {
  const item = crlTargetItem(config, catalog, targetId);
  if (item === undefined) {
    return undefined;
  }
  const current = catalog.targets[targetId]?.current ?? null;
  if (item.current === null || current === null) {
    return { ...item, current: null };
  }
  const blob = await checkedBlob(store, current.key, current.sha256);
  // One parse per request: on a large CRL it costs several times the projection.
  const crl = parseCRL(blob.der);
  return {
    ...item,
    current: {
      ...item.current,
      verifier: current.verifier,
      fingerprints: blob.fingerprints,
      tbsCertList: buildTBSCertList(crl),
      ...signature(crl),
    },
  };
}

// Stats -------------------------------------------------------------------------------------------

/**
 * GET /api/v1/stats, from config.json and catalog.json alone: no blob is read and the store is
 * never listed (history blobs are not counted; listing them is an admin operation).
 */
export function stats(config: Config, catalog: Catalog) {
  let certificates = 0;
  let derBytes = 0;
  let totalRevocations: number | null = null;
  const targets = { full: 0, delta: 0 };
  const published = { full: 0, delta: 0 };
  for (const entry of Object.values(catalog.certificates)) {
    certificates++;
    derBytes += entry.size;
  }
  for (const [targetId, target] of Object.entries(config.targets)) {
    targets[target.kind]++;
    const current = catalog.targets[targetId]?.current ?? null;
    if (current === null) {
      continue;
    }
    published[target.kind]++;
    derBytes += current.size;
    if (target.kind === "full") {
      totalRevocations = (totalRevocations ?? 0) + current.summary.revokedCount;
    }
  }
  return { certificates, targets, published, totalRevocations, derBytes };
}
