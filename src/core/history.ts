// A CRL target's history (plan §5.3), for the admin API: every version that was published as the
// target's current, from one `list` of its blob prefix and one of its marker prefix, paired by
// name (crlVersionName), so no blob or marker is read. A version is history when it has a marker
// (a superseded current) or is the catalog's current. A blob without either is an orphan of a
// lost publish race or a crash and is not listed. The catalog is read before the lists: a publish
// writes the blob and the marker before the catalog and nothing removes them, so the lists hold
// every version that catalog names.
import { readState } from "./catalog.ts";
import { parseCrlVersionName } from "./publish.ts";
import type { ObjectStore } from "./store.ts";

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
  const blobPrefix = `blobs/crls/${targetId}/`;
  const markerPrefix = `history/${targetId}/`;
  const { config, catalog } = await readState(store);
  const [blobs, markers] = await Promise.all([store.list(blobPrefix), store.list(markerPrefix)]);
  const configured = config?.targets[targetId] !== undefined;
  const current = catalog.targets[targetId]?.current ?? null;
  // Version names: a marker's key and its blob's key without prefix and extension.
  const marked = new Set(
    markers.flatMap(({ key }) =>
      key.endsWith(".json") ? [key.slice(markerPrefix.length, -5)] : []
    )
  );

  const entries: StoredEntry[] = [];
  for (const { key, size } of blobs) {
    const version = key.endsWith(".der") ? key.slice(blobPrefix.length, -4) : "";
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
  const blob = await deps.store.get(found.key);
  if (blob === null) {
    throw new Error(`The store has no blob ${found.key}`);
  }
  const { key: _key, ...entry } = found;
  return { entry, der: blob.bytes };
}
