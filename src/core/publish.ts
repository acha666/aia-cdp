// CRL publishing (plan §5.5, implementation slice 4): blob keys and the freshness rule. publishCrl
// itself follows in step 6.
import { formatGeneralizedTime } from "./pki/asn1.ts";
import type { CrlSummary } from "./summary/catalog-summary.ts";

/**
 * `<YYYYMMDDHHMMSSZ of thisUpdate>-<crlNumber or "none">-<sha256>`: the name of one CRL version,
 * shared by its blob and by its history marker (plan §5.1). The fixed-width time first makes a
 * `list` of either prefix sort by thisUpdate; the number lets slice 6 list a target's history
 * without reading the blobs.
 */
export function crlVersionName(
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  const time = formatGeneralizedTime(new Date(summary.thisUpdate));
  return `${time}-${summary.crlNumber ?? "none"}-${sha256}`;
}

/** Store key of a published CRL's DER (plan §5.1); current and history share it. */
export function crlBlobKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `blobs/crls/${targetId}/${crlVersionName(summary, sha256)}.der`;
}

// Freshness (step 5; C3, M15) ----------------------------------------------------------------------

/** What compareFreshness reads of a CRL: the catalog `current` record has this shape. */
export interface FreshnessInput {
  sha256: string;
  summary: Pick<CrlSummary, "crlNumber" | "thisUpdate">;
}

/** created / updated publish; the other four end the upload without a write. */
export type Freshness =
  "created" | "unchanged" | "updated" | "stale_crl" | "conflict" | "non_orderable";

// BigInt() alone would also take "", " 7" and "0x10".
function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(`Not a decimal CRL number: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function epochMs(time: string): number {
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Not a time: ${JSON.stringify(time)}`);
  }
  return ms;
}

/**
 * Whether `incoming` may replace the target's `current` CRL (rewrite of
 * worker-aia-cdp@5b570aa:src/worker/pki/crls.ts:17-44, isNewerCRL), from the catalog summaries
 * alone, never the current DER:
 *
 * 0. no current → created;
 * 1. same sha256 → unchanged (§10 #4);
 * 2. a CRL Number on exactly one side → non_orderable;
 * 3. numbers on both sides: higher → updated, lower → stale_crl, equal → row 4;
 * 4. equal numbers or none on either side, by thisUpdate: later → updated, the same instant →
 *    conflict (other bytes for the same CRL), earlier → stale_crl.
 *
 * Numbers compare as BigInt and times as epoch milliseconds, never as strings (a time with and one
 * without milliseconds are the same instant). nextUpdate plays no part, and a full and a delta
 * target are compared separately (AD CS numbers both from one counter, so each sequence has gaps).
 * Throws on a malformed number or time, which the catalog schema and buildCrlSummary rule out.
 */
export function compareFreshness(
  current: FreshnessInput | null | undefined,
  incoming: FreshnessInput
): Freshness {
  if (current === null || current === undefined) {
    return "created";
  }
  if (current.sha256 === incoming.sha256) {
    return "unchanged";
  }
  const before = current.summary.crlNumber;
  const after = incoming.summary.crlNumber;
  if ((before === null) !== (after === null)) {
    return "non_orderable";
  }
  if (before !== null && after !== null) {
    const order = decimal(after) - decimal(before);
    if (order !== 0n) {
      return order > 0n ? "updated" : "stale_crl";
    }
  }
  const order = epochMs(incoming.summary.thisUpdate) - epochMs(current.summary.thisUpdate);
  if (order === 0) {
    return "conflict";
  }
  return order > 0 ? "updated" : "stale_crl";
}
