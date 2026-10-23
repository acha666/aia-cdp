// Validity states of certificates and CRL targets, the one rule behind the status badges and the
// overview's "needs attention" count. Bounds are inclusive (valid at notAfter, expired one
// millisecond later) and the distances are in whole seconds. The clock is always passed in
// (useClock in components), so every badge on a page reads the same instant.
import type { CrlTargetListItem } from "@/client/types";

/** `expiring`: valid, with less than 10% of the validity period left. */
export type CertificateStatusState = "valid" | "expiring" | "expired" | "not-yet-valid" | "unknown";

/** `unpublished`: the target has no current CRL. */
export type CrlStatusState =
  "current" | "stale" | "expired" | "not-yet-valid" | "unknown" | "unpublished";

export interface CertificateStatus {
  state: CertificateStatusState;
  /** Seconds until notBefore (not-yet-valid). */
  startsIn?: number;
  /** Seconds until notAfter (valid, expiring). */
  expiresIn?: number;
  /** Seconds since notAfter (expired). */
  expiredAgo?: number;
}

export interface CrlStatus {
  state: CrlStatusState;
  /** Seconds until nextUpdate (current, stale). */
  expiresIn?: number;
  /** Seconds since nextUpdate (expired). */
  expiredAgo?: number;
}

/** The summary fields of a target's current CRL that its status depends on. */
export type CrlTimes = Pick<
  NonNullable<CrlTargetListItem["current"]>["summary"],
  "thisUpdate" | "nextUpdate" | "nextPublish"
>;

const SECOND_MS = 1000;
/** How long after its Next CRL Publish an AD CS CRL may stay current (publish → helper upload). */
const NEXT_PUBLISH_GRACE_MS = 60 * 60 * 1000;

function parseIsoDate(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Missing, malformed or inverted dates give `unknown`, never `valid`. Expiring: less than 10% of
 * notBefore → notAfter remains (a 20-year root two years ahead, a 10-year issuing CA one year).
 */
export function computeCertificateStatus(
  notBefore: string | null | undefined,
  notAfter: string | null | undefined,
  nowMs: number
): CertificateStatus {
  const start = parseIsoDate(notBefore);
  const end = parseIsoDate(notAfter);
  if (start === null || end === null || end < start) {
    return { state: "unknown" };
  }
  if (nowMs < start) {
    return { state: "not-yet-valid", startsIn: Math.floor((start - nowMs) / SECOND_MS) };
  }
  if (nowMs > end) {
    return { state: "expired", expiredAgo: Math.floor((nowMs - end) / SECOND_MS) };
  }
  const remaining = end - nowMs;
  // remaining < 10% of the period, in integers (no 0.1 rounding at the boundary).
  return {
    state: remaining * 10 < end - start ? "expiring" : "valid",
    expiresIn: Math.floor(remaining / SECOND_MS),
  };
}

/**
 * Status of a CRL from its own times. Without nextUpdate (or with dates out of order) it is
 * `unknown`; after nextUpdate `expired`. Before that it is stale when:
 * - it carries an AD CS Next CRL Publish: more than an hour after that time (the CA should have
 *   published its successor by then, and this one is still current);
 * - otherwise (e.g. an offline root's CRL): when less than 20% of thisUpdate → nextUpdate remains.
 */
export function computeCrlStatus(
  thisUpdate: string | null | undefined,
  nextUpdate: string | null | undefined,
  nowMs: number,
  nextPublish: string | null = null
): CrlStatus {
  const start = parseIsoDate(thisUpdate);
  const end = parseIsoDate(nextUpdate);
  if (start === null || end === null || end <= start) {
    return { state: "unknown" };
  }
  if (nowMs < start) {
    return { state: "not-yet-valid" };
  }
  if (nowMs > end) {
    return { state: "expired", expiredAgo: Math.floor((nowMs - end) / SECOND_MS) };
  }
  const publish = parseIsoDate(nextPublish);
  // elapsed > 80% of the period, in integers.
  const stale =
    publish === null
      ? (nowMs - start) * 5 > (end - start) * 4
      : nowMs > publish + NEXT_PUBLISH_GRACE_MS;
  return {
    state: stale ? "stale" : "current",
    expiresIn: Math.floor((end - nowMs) / SECOND_MS),
  };
}

/** Status of a target from its current CRL (list item or detail); `unpublished` without one. */
export function computeTargetStatus(
  current: { summary: CrlTimes } | null,
  nowMs: number
): CrlStatus {
  if (current === null) {
    return { state: "unpublished" };
  }
  const { thisUpdate, nextUpdate, nextPublish } = current.summary;
  return computeCrlStatus(thisUpdate, nextUpdate, nowMs, nextPublish);
}

/** The overview's "needs attention" count: stale, expired and unknown targets. */
export function needsAttention(state: CrlStatusState): boolean {
  return state === "stale" || state === "expired" || state === "unknown";
}
