// A CRL version in the store (plan §5.1): its name, blob key and history marker key, which
// publishCrl (./publish.ts) writes; and a CRL target's history (plan §5.3), for the admin API:
// every version that was published as the target's current, from one `list` of its blob prefix and
// one of its marker prefix, paired by name, so no blob or marker is read. A version is history when
// it has a marker (a superseded current) or is the catalog's current. A blob without either is an
// orphan of a lost publish race or a crash and is not listed. The catalog is read before the lists:
// a publish writes the blob and the marker before the catalog and nothing removes them, so the
// lists hold every version that catalog names.
import { readState } from "./catalog.ts";
import type { CrlSummary, CurrentCrl } from "./catalog.ts";
import { formatGeneralizedTime } from "./pki/asn1.ts";
import { readBlob } from "./store.ts";
import type { ObjectStore } from "./store.ts";

// Store layout ------------------------------------------------------------------------------------

/**
 * `<YYYYMMDDHHMMSSZ of thisUpdate>-<crlNumber or "none">-<sha256>`: the name of one CRL version,
 * shared by its blob and by its history marker (plan §5.1). The fixed-width time first makes a
 * `list` of either prefix sort by thisUpdate; the number lets a target's history be listed without
 * reading the blobs.
 */
export function crlVersionName(
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  const time = formatGeneralizedTime(new Date(summary.thisUpdate));
  return `${time}-${summary.crlNumber ?? "none"}-${sha256}`;
}

const VERSION_NAME =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z-(0|[1-9][0-9]*|none)-([0-9a-f]{64})$/;

/**
 * The fields of a crlVersionName, or undefined for a name of another shape (only an out-of-band
 * write makes one). `thisUpdate` in the catalog's format, exactly: CRL times are whole seconds.
 */
function parseCrlVersionName(
  name: string
): { thisUpdate: string; crlNumber: string | null; sha256: string } | undefined {
  const match = VERSION_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, crlNumber, sha256 = ""] = match;
  return {
    thisUpdate: `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`,
    crlNumber: crlNumber === "none" || crlNumber === undefined ? null : crlNumber,
    sha256,
  };
}

const BLOB_EXTENSION = ".der";
const MARKER_EXTENSION = ".json";

const crlBlobPrefix = (targetId: string) => `blobs/crls/${targetId}/`;
const crlHistoryPrefix = (targetId: string) => `history/${targetId}/`;

/** Store key of a published CRL's DER (plan §5.1); current and history share it. */
export function crlBlobKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlBlobPrefix(targetId)}${crlVersionName(summary, sha256)}${BLOB_EXTENSION}`;
}

/**
 * Store key of the history marker of one CRL version of a target (plan §5.1, §5.3): the name of
 * its blob as JSON, so that a `list` of both prefixes pairs them without reading either.
 */
export function crlHistoryKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlHistoryPrefix(targetId)}${crlVersionName(summary, sha256)}${MARKER_EXTENSION}`;
}

/**
 * Body of a history marker written when a publish supersedes `current`: that record verbatim. No
 * time of its own: a marker is create-only and may come from a call whose catalog write was then
 * lost (concurrent_update) while the version stayed current, so a time written then would stay
 * wrong forever. When the version was superseded is the `publishedAt` of the version that
 * superseded it.
 */
export type HistoryMarker = CurrentCrl;

// The version name of a listed key: the key without `prefix` and `extension`; "" (which is no
// version name) for a key with another extension.
function versionName(key: string, prefix: string, extension: string): string {
  return key.endsWith(extension) ? key.slice(prefix.length, -extension.length) : "";
}

// History -----------------------------------------------------------------------------------------

export interface HistoryEntry {
  /** SHA-256 of the DER. */
  sha256: string;
  crlNumber: string | null;
  thisUpdate: string;
  /** DER size in bytes. */
  size: number;
  /** The version the target serves: its current CRL, while the target is in config.json. */
  current: boolean;
}

export interface TargetHistory {
  targetId: string;
  /** false once the target was removed from config.json (retired): nothing serves it any more. */
  configured: boolean;
  /** Newest first: by thisUpdate, then CRL Number. */
  entries: HistoryEntry[];
}

/** An entry with the key of its blob, which never leaves this module. */
type StoredEntry = HistoryEntry & { key: string };

// A CRL without a number sorts below any number.
function numberOrder(crlNumber: string | null): bigint {
  return crlNumber === null ? -1n : BigInt(crlNumber);
}

function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  if (a.thisUpdate !== b.thisUpdate) {
    return a.thisUpdate < b.thisUpdate ? 1 : -1;
  }
  const [x, y] = [numberOrder(a.crlNumber), numberOrder(b.crlNumber)];
  return x === y ? 0 : x < y ? 1 : -1;
}

async function storedHistory(
  store: ObjectStore,
  targetId: string
): Promise<{ configured: boolean; entries: StoredEntry[] } | undefined> {
  const blobPrefix = crlBlobPrefix(targetId);
  const markerPrefix = crlHistoryPrefix(targetId);
  const { config, catalog } = await readState(store);
  const [blobs, markers] = await Promise.all([store.list(blobPrefix), store.list(markerPrefix)]);
  const configured = config.targets[targetId] !== undefined;
  const current = catalog.targets[targetId]?.current ?? null;
  const marked = new Set(
    markers.map(({ key }) => versionName(key, markerPrefix, MARKER_EXTENSION))
  );

  const entries: StoredEntry[] = [];
  for (const { key, size } of blobs) {
    const version = versionName(key, blobPrefix, BLOB_EXTENSION);
    const fields = parseCrlVersionName(version);
    const isCurrent = key === current?.key;
    if (fields !== undefined && (isCurrent || marked.has(version))) {
      entries.push({ ...fields, size, current: isCurrent && configured, key });
    }
  }
  if (current !== null && !entries.some((entry) => entry.key === current.key)) {
    throw new Error(`The store has no blob ${current.key}`);
  }
  if (!configured && entries.length === 0) {
    return undefined;
  }
  return { configured, entries: entries.sort(newestFirst) };
}

/**
 * The history of a target, also of one removed from config.json; not_found for a target that is
 * neither configured nor has a history. Throws when the catalog's current has no blob.
 */
export async function listHistory(
  deps: { store: ObjectStore },
  targetId: string
): Promise<TargetHistory | { error: "not_found" }> {
  const history = await storedHistory(deps.store, targetId);
  if (history === undefined) {
    return { error: "not_found" };
  }
  const entries = history.entries.map(({ key: _key, ...entry }) => entry);
  return { targetId, configured: history.configured, entries };
}

/**
 * The DER of the history entry with digest `sha256`; not_found when the target's history has no
 * such entry. Served as stored, like a download: the key is content-addressed.
 */
export async function getHistoryBlob(
  deps: { store: ObjectStore },
  targetId: string,
  sha256: string
): Promise<{ entry: HistoryEntry; der: Uint8Array<ArrayBuffer> } | { error: "not_found" }> {
  const found = (await storedHistory(deps.store, targetId))?.entries.find(
    (entry) => entry.sha256 === sha256
  );
  if (found === undefined) {
    return { error: "not_found" };
  }
  const { key, ...entry } = found;
  return { entry, der: await readBlob(deps.store, key) };
}
