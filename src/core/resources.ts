// Downloads (plan §6): which resource a request path names and the headers it is served with.
// Pure: the route reads config.json and catalog.json once each, and the blob only for a GET that is
// not answered 304.
//
// Only what the current config's path table and the catalog name is reachable: the request path is
// never a store key, so blobs/, history/, config.json and catalog.json cannot be downloaded, and a
// path table entry the catalog or config cannot back is reported as `inconsistent` (a 500) instead
// of being served from somewhere else.
import type { Catalog, Config, ConfigPath, CrlKind } from "./catalog.ts";
import type { PkiKind } from "./pki/errors.ts";
import { pemLength } from "./pki/pem.ts";

/** A certificate (/ca/) or a target's CRL (/crl/ full, /dcrl/ delta): what the headers go by. */
export type DownloadKind = "certificate" | CrlKind;

/** DER as stored, or PEM derived on read (`<path>.pem`). */
export type DownloadFormat = "der" | "pem";

export interface FoundDownload {
  status: "found";
  kind: DownloadKind;
  format: DownloadFormat;
  /** SHA-256 of the DER from the catalog (the certificate id, or current.sha256). */
  sha256: string;
  /** Store key of the DER blob. */
  key: string;
  /** DER size in bytes, from the catalog. */
  size: number;
  /**
   * Last segment of the request path, `.pem` included. The path is a config path (plus `.pem`),
   * never other request text, so it goes into Content-Disposition as it is.
   */
  filename: string;
  /** The CRL's nextUpdate; null for a certificate and for a CRL without one. */
  nextUpdate: Date | null;
  /** importedAt of a certificate, current.publishedAt of a CRL. */
  lastModified: Date;
}

/**
 * `inconsistent`: the path table references a certificate the catalog does not hold, or a target
 * config.targets does not define (`reference` is that path entry), e.g. a certificate deleted
 * while applyConfig ran.
 */
export type DownloadResolution =
  FoundDownload | { status: "not_found" } | { status: "inconsistent"; reference: ConfigPath };

const NOT_FOUND = { status: "not_found" } as const;

const PEM_SUFFIX = ".pem";

// Own properties only: a request path or a stored id must never reach Object.prototype
// ("constructor", "__proto__", "toString"), whatever the schemas let through.
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The resource `path` names. `path` is Hono's `c.req.path` (decoded with decodeURI, so `%2F` and
 * malformed `%` sequences stay as they are) and is not decoded again.
 *
 * - An own key of config.paths, matched exactly and case-sensitively → DER; otherwise a path
 *   ending in `.pem` whose stripped form is such a key → PEM (one suffix: `.pem.pem` is not
 *   found, since config paths never end in `.pem`). Anything else, or no config.json (null) →
 *   not_found.
 * - A certificate path → catalog.certificates[id]; missing → inconsistent.
 * - A target path → config.targets[id] (missing → inconsistent) for the kind, and
 *   catalog.targets[id].current for the CRL: no catalog entry (never published) or a null current
 *   → not_found (plan §6).
 */
export function resolveDownload(
  config: Config | null,
  catalog: Catalog,
  path: string
): DownloadResolution {
  if (config === null) {
    return NOT_FOUND;
  }
  let format: DownloadFormat = "der";
  let entry = own(config.paths, path);
  if (entry === undefined && path.endsWith(PEM_SUFFIX)) {
    format = "pem";
    entry = own(config.paths, path.slice(0, -PEM_SUFFIX.length));
  }
  if (entry === undefined) {
    return NOT_FOUND;
  }
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if ("certificate" in entry) {
    const certificate = own(catalog.certificates, entry.certificate);
    if (certificate === undefined) {
      return { status: "inconsistent", reference: { certificate: entry.certificate } };
    }
    return {
      status: "found",
      kind: "certificate",
      format,
      sha256: entry.certificate,
      key: certificate.key,
      size: certificate.size,
      filename,
      nextUpdate: null,
      lastModified: new Date(certificate.importedAt),
    };
  }
  const target = own(config.targets, entry.target);
  if (target === undefined) {
    return { status: "inconsistent", reference: { target: entry.target } };
  }
  const current = own(catalog.targets, entry.target)?.current ?? null;
  if (current === null) {
    return NOT_FOUND;
  }
  const { nextUpdate } = current.summary;
  return {
    status: "found",
    kind: target.kind,
    format,
    sha256: current.sha256,
    key: current.key,
    size: current.size,
    filename,
    nextUpdate: nextUpdate === null ? null : new Date(nextUpdate),
    lastModified: new Date(current.publishedAt),
  };
}

/**
 * The reverse of resolveDownload: the paths that serve a certificate or a target (`downloads` of
 * the upload response, plan §7.1, and of the read API's lists). Every config path mapped to
 * `reference`, in code-unit order, each DER path followed by its `<path>.pem`; [] without
 * config.json. Only path table entries, never a store key.
 */
export function downloadPaths(config: Config | null, reference: ConfigPath): string[] {
  if (config === null) {
    return [];
  }
  const matches = ([, entry]: [string, ConfigPath]) =>
    "certificate" in reference
      ? "certificate" in entry && entry.certificate === reference.certificate
      : "target" in entry && entry.target === reference.target;
  return Object.entries(config.paths)
    .filter(matches)
    .map(([path]) => path)
    .sort()
    .flatMap((path) => [path, `${path}${PEM_SUFFIX}`]);
}

// Header policy ----------------------------------------------------------------------------------

/** The headers of a found download; a 304 carries only ETag and Cache-Control of them. */
export interface DownloadHeaders {
  "Content-Type": string;
  ETag: string;
  "Content-Length": string;
  "Cache-Control": string;
  "Last-Modified": string;
  "Content-Disposition": string;
}

// By kind, not by path suffix; PEM is application/x-pem-file, never text/plain.
const DER_CONTENT_TYPES: Record<DownloadKind, string> = {
  certificate: "application/pkix-cert",
  full: "application/pkix-crl",
  delta: "application/pkix-crl",
};

const PEM_CONTENT_TYPE = "application/x-pem-file";

// No s-maxage / stale-while-revalidate. A certificate path never changes its bytes (V7; a two-step
// rebind is the operator's responsibility).
const CERTIFICATE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** CRL max-age bounds in seconds: an expired CRL still gets 60, a far one at most 3600. */
const CRL_MAX_AGE = { min: 60, max: 3600, withoutNextUpdate: 300 } as const;

/** The PkiKind of a download kind: derToPem and pemLength take it. */
export function pemKind(kind: DownloadKind): PkiKind {
  return kind === "certificate" ? "certificate" : "crl";
}

// Whole seconds until nextUpdate, clamped.
function crlMaxAge(nextUpdate: Date | null, now: Date): number {
  if (nextUpdate === null) {
    return CRL_MAX_AGE.withoutNextUpdate;
  }
  const seconds = Math.floor((nextUpdate.getTime() - now.getTime()) / 1000);
  return Math.min(CRL_MAX_AGE.max, Math.max(CRL_MAX_AGE.min, seconds));
}

function cacheControl(found: FoundDownload, now: Date): string {
  return found.kind === "certificate"
    ? CERTIFICATE_CACHE_CONTROL
    : `public, max-age=${crlMaxAge(found.nextUpdate, now)}, must-revalidate`;
}

/**
 * Response headers of a found download, the same for GET, HEAD and (ETag, Cache-Control) 304:
 *
 * - ETag `"<sha256>"` (DER) or `"<sha256>-pem"` (PEM) from the catalog digest; a store ETag never
 *   leaves the adapter.
 * - Content-Length the catalog size, or pemLength of it: known without reading the blob.
 * - Cache-Control: certificates immutable for a year; CRLs `max-age` = whole seconds until
 *   nextUpdate clamped to [60, 3600], 300 without nextUpdate, and must-revalidate.
 * - Last-Modified: importedAt / publishedAt as an HTTP date. Informational only:
 *   If-Modified-Since is not evaluated (one-second precision; the ETag covers revalidation).
 */
export function downloadHeaders(found: FoundDownload, now: Date): DownloadHeaders {
  const pem = found.format === "pem";
  return {
    "Content-Type": pem ? PEM_CONTENT_TYPE : DER_CONTENT_TYPES[found.kind],
    ETag: pem ? `"${found.sha256}-pem"` : `"${found.sha256}"`,
    "Content-Length": String(pem ? pemLength(found.size, pemKind(found.kind)) : found.size),
    "Cache-Control": cacheControl(found, now),
    "Last-Modified": found.lastModified.toUTCString(),
    "Content-Disposition": `attachment; filename="${found.filename}"`,
  };
}

const stripWeak = (tag: string) => tag.replace(/^W\//, "");

/**
 * Whether `If-None-Match` matches `etag` (a quoted download ETag), as hono/etag's etagMatches
 * compares, plus `*`: the whole header trimmed is `*`, or one of its comma-separated members,
 * trimmed, equals `etag` once a `W/` prefix is removed from both (weak comparison, RFC 9110
 * §13.1.2). An unquoted value never matches (the client gets a full download); a missing or empty
 * header never does.
 */
export function ifNoneMatchHit(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }
  const wanted = stripWeak(etag);
  return header.split(",").some((member) => stripWeak(member.trim()) === wanted);
}
