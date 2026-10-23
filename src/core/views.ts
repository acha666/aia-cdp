// The read model of the public API (plan §5.6, §7.1): certificate and CRL target lists, their
// details and the stats, as pure functions of config.json and catalog.json (one `get` each per
// request, through readState in ./catalog.ts) plus, for a detail, the DER of the one blob it shows.
// Ids and kinds come from the catalog and config, never from a store key, and a store key never
// appears in a view.
//
// Lists are complete arrays (no pagination), certificates in id order and targets in targetId
// order (code units; the UI sorts for display). Without config.json the certificates come from the
// catalog alone, with no labels, downloads or targets, and there are no targets.
//
// What the catalog and config name but the store cannot back throws, and the HTTP layer answers
// its generic 500: never a 404, an empty list or a partial 200.
import type { BitString } from "asn1js";
import type * as pkijs from "pkijs";
import type { Catalog, CatalogCertificate, Config, CrlKind, CurrentCrl } from "./catalog.ts";
import { SIGNATURE_ALG_NAMES } from "./pki/constants.ts";
import { parseCertificate, parseCRL } from "./pki/parsers.ts";
import { downloadPaths } from "./resources.ts";
import { buildTBSCertificate } from "./summary/certificate.ts";
import { buildTBSCertList } from "./summary/crl.ts";
import {
  buildAlgorithmIdentifier,
  buildFingerprints,
  buildSignatureValue,
} from "./summary/primitives.ts";
import type {
  AlgorithmIdentifier,
  Fingerprints,
  SignatureValue,
  TBSCertificate,
  TBSCertList,
} from "./summary/types.ts";

// Views -------------------------------------------------------------------------------------------

/** A target that names the certificate as its issuer. */
export interface CertificateTarget {
  targetId: string;
  kind: CrlKind;
  label: string;
}

export interface CertificateListItem {
  /** SHA-256 of the DER, lowercase hex. */
  id: string;
  /** config.certificates[id].label; null when not configured. */
  label: string | null;
  importedAt: string;
  /** DER size in bytes. */
  size: number;
  /** The catalog summary as imported (CN and key ids may be null). */
  summary: CatalogCertificate["summary"];
  /** downloadPaths of the certificate: DER paths in code-unit order, each followed by its .pem. */
  downloads: string[];
  /** The configured targets this certificate issues CRLs for, in targetId order. */
  targets: CertificateTarget[];
}

/** The list item, plus the projection of the stored DER, built whole on every request. */
export interface CertificateDetail extends CertificateListItem {
  fingerprints: Fingerprints;
  tbsCertificate: TBSCertificate;
  signatureAlgorithm: AlgorithmIdentifier;
  signatureValue: SignatureValue;
}

/** A target's issuer certificate: its config label and its subject CN. */
export interface CrlIssuer {
  id: string;
  label: string | null;
  subjectCN: string | null;
}

/** The target's current CRL as the catalog records it, without its store key or verifier. */
export interface CrlCurrent {
  sha256: string;
  size: number;
  publishedAt: string;
  /** buildCrlSummary at publish time: revokedCount always known, nextPublish nullable. */
  summary: CurrentCrl["summary"];
}

export interface CrlTargetListItem {
  targetId: string;
  /** From config.json, not from a Delta CRL Indicator. */
  kind: CrlKind;
  label: string;
  issuer: CrlIssuer;
  downloads: string[];
  /** null while nothing is published (or after a retire): the UI says "not published". */
  current: CrlCurrent | null;
}

export interface CrlCurrentDetail extends CrlCurrent {
  /** Id of the certificate whose key verified the signature at publish time. */
  verifier: string;
  fingerprints: Fingerprints;
  /** Every revoked entry: revokedCertificates is { count, items }, never a page. */
  tbsCertList: TBSCertList;
  signatureAlgorithm: AlgorithmIdentifier;
  signatureValue: SignatureValue;
}

export interface CrlTargetDetail extends Omit<CrlTargetListItem, "current"> {
  current: CrlCurrentDetail | null;
}

export interface KindCounts {
  full: number;
  delta: number;
}

/**
 * Counts and bytes of what the lists show. No time-dependent field: what is expired, stale or
 * needs attention is computed by the UI with its own clock.
 */
export interface Stats {
  /** Imported certificates (catalog). */
  certificates: number;
  /** Configured targets by kind. */
  targets: KindCounts;
  /** Configured targets with a current CRL, by kind. */
  published: KindCounts;
  /**
   * Sum of revokedCount over the published full CRLs; null when no full CRL is published. Delta
   * entries are not counted: they reappear in the next full CRL.
   */
  totalRevocations: number | null;
  /** DER bytes of the imported certificates and of the configured targets' current CRLs. */
  derBytes: number;
}

// Helpers -----------------------------------------------------------------------------------------

/** Keys in code-unit order. */
function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

/**
 * `der` with its fingerprints, when it is the DER whose SHA-256 the catalog records: a missing blob
 * (null) or one with another digest throws. Checked before parsing, so a detail never shows other
 * bytes under the catalog's id.
 */
async function checkedBlob(
  der: Uint8Array | null,
  sha256: string,
  key: string
): Promise<{ der: Uint8Array; fingerprints: Fingerprints }> {
  if (der === null) {
    throw new Error(`The store has no blob ${key}`);
  }
  const fingerprints = await buildFingerprints(der);
  if (fingerprints.sha256 !== sha256) {
    throw new Error(`Blob ${key} does not have the catalog's SHA-256`);
  }
  return { der, fingerprints };
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

function certificateItem(
  config: Config | null,
  id: string,
  entry: CatalogCertificate
): CertificateListItem {
  const targets =
    config === null
      ? []
      : sortedKeys(config.targets).flatMap((targetId) => {
          const target = config.targets[targetId];
          return target?.issuer === id
            ? [{ targetId, kind: target.kind, label: target.label }]
            : [];
        });
  return {
    id,
    label: config === null ? null : (config.certificates[id]?.label ?? null),
    importedAt: entry.importedAt,
    size: entry.size,
    summary: entry.summary,
    downloads: downloadPaths(config, { certificate: id }),
    targets,
  };
}

/** GET /api/v1/certificates: one item per catalog certificate, in id order. */
export function certificateList(config: Config | null, catalog: Catalog): CertificateListItem[] {
  return sortedKeys(catalog.certificates).flatMap((id) => {
    const entry = catalog.certificates[id];
    return entry === undefined ? [] : [certificateItem(config, id, entry)];
  });
}

/** What a certificate detail is built from: its list item and the store key of its DER. */
export interface CertificateSource {
  item: CertificateListItem;
  key: string;
}

/** The catalog certificate `id` (lowercase hex), or undefined when it was never imported. */
export function findCertificate(
  config: Config | null,
  catalog: Catalog,
  id: string
): CertificateSource | undefined {
  const entry = catalog.certificates[id];
  return entry === undefined
    ? undefined
    : { item: certificateItem(config, id, entry), key: entry.key };
}

/**
 * GET /api/v1/certificates/{id}: the list item plus fingerprints, TBSCertificate, signature
 * algorithm (with its parameters) and signature value of `der`, the blob at `source.key` (null
 * when the store has none). Throws for a missing blob, other bytes or a blob that does not parse.
 */
export async function certificateDetail(
  source: CertificateSource,
  der: Uint8Array | null
): Promise<CertificateDetail> {
  const { item, key } = source;
  const blob = await checkedBlob(der, item.id, key);
  const certificate = parseCertificate(blob.der);
  return {
    ...item,
    fingerprints: blob.fingerprints,
    tbsCertificate: await buildTBSCertificate(certificate),
    ...signature(certificate),
  };
}

// CRL targets -------------------------------------------------------------------------------------

function crlTargetItem(
  config: Config,
  catalog: Catalog,
  targetId: string
): { item: CrlTargetListItem; current: CurrentCrl | null } | undefined {
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
    item: {
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
    },
    current,
  };
}

/**
 * GET /api/v1/crls: one item per configured target, in targetId order; [] without config.json. A
 * catalog current whose target config.json no longer defines is not listed (no kind, no paths).
 */
export function crlTargetList(config: Config | null, catalog: Catalog): CrlTargetListItem[] {
  if (config === null) {
    return [];
  }
  return sortedKeys(config.targets).flatMap(
    (targetId) => crlTargetItem(config, catalog, targetId)?.item ?? []
  );
}

/** What a CRL target detail is built from: its list item and its current record, if any. */
export interface CrlTargetSource {
  item: CrlTargetListItem;
  /** The catalog's current record (key and verifier included); null while unpublished. */
  current: CurrentCrl | null;
}

/** The configured target `targetId` (lowercase), or undefined when config.json has none. */
export function findCrlTarget(
  config: Config | null,
  catalog: Catalog,
  targetId: string
): CrlTargetSource | undefined {
  return config === null ? undefined : crlTargetItem(config, catalog, targetId);
}

/**
 * GET /api/v1/crls/{targetId}: the list item, and for a published target its current CRL with
 * verifier, fingerprints, TBSCertList (every revoked entry), signature algorithm and value of
 * `der`, the blob at `source.current.key` (null when the store has none; not read and ignored while
 * unpublished). Throws like certificateDetail.
 */
export async function crlTargetDetail(
  source: CrlTargetSource,
  der: Uint8Array | null
): Promise<CrlTargetDetail> {
  const { item, current } = source;
  if (item.current === null || current === null) {
    return { ...item, current: null };
  }
  const blob = await checkedBlob(der, current.sha256, current.key);
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
 * never listed (history blobs are not counted; listing them is an admin operation). A configured
 * target whose issuer is not in the catalog throws, as in the CRL lists: the counts never
 * describe a state the lists refuse to show.
 */
export function stats(config: Config | null, catalog: Catalog): Stats {
  const result: Stats = {
    certificates: 0,
    targets: { full: 0, delta: 0 },
    published: { full: 0, delta: 0 },
    totalRevocations: null,
    derBytes: 0,
  };
  for (const entry of Object.values(catalog.certificates)) {
    result.certificates++;
    result.derBytes += entry.size;
  }
  for (const [targetId, target] of Object.entries(config?.targets ?? {})) {
    if (catalog.certificates[target.issuer] === undefined) {
      throw new Error(
        `Target ${targetId} names issuer ${target.issuer}, which is not in the catalog`
      );
    }
    result.targets[target.kind]++;
    const current = catalog.targets[targetId]?.current ?? null;
    if (current === null) {
      continue;
    }
    result.published[target.kind]++;
    result.derBytes += current.size;
    if (target.kind === "full") {
      result.totalRevocations = (result.totalRevocations ?? 0) + current.summary.revokedCount;
    }
  }
  return result;
}
