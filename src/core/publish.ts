// CRL publishing (plan §5.5, implementation slice 4 steps 2, 5 and 6): blob and history keys, the
// freshness rule and publishCrl. There is one commit point, the catalog write: no PEM or alias
// companions, no edge cache (§10 #5, #6). Rewrite of the core of
// worker-aia-cdp@5b570aa:src/worker/api/v2/crls/upload.ts and of the issuer lookup in
// src/worker/r2/certificates.ts; the HTTP route maps the result (slice 4 step 8).
import type { CertificateRevocationList } from "pkijs";
import {
  CrlSummarySchema,
  encodeJson,
  JSON_CONTENT_TYPE,
  realSleep,
  updateState,
} from "./catalog.ts";
import type { CatalogMutation, CrlKind, CurrentCrl, State } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { formatGeneralizedTime } from "./pki/asn1.ts";
import { checkCrlPolicy } from "./pki/crl-policy.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { getAuthorityKeyIdHex, parseCertificate, parseCRL } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { verifyCrlSignature } from "./pki/verify.ts";
import type { SignatureCheck } from "./pki/verify.ts";
import { downloadPaths } from "./resources.ts";
import type { ObjectStore } from "./store.ts";
import { buildCrlSummary } from "./summary/catalog-summary.ts";
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

/**
 * Store key of the history marker of one CRL version of a target (plan §5.1, §5.3): the name of
 * its blob as JSON, so that a `list` of both prefixes pairs them without reading either.
 */
export function crlHistoryKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `history/${targetId}/${crlVersionName(summary, sha256)}.json`;
}

/**
 * Body of a history marker written when a publish supersedes `current`: that record as it was,
 * plus when it was superseded (slice 6's retire writes the same shape; slice 7's history import
 * has `importedAt` instead).
 */
export type HistoryMarker = CurrentCrl & { supersededAt: string };

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

// publishCrl (step 6) ------------------------------------------------------------------------------

/** The DER blob is written with this type (R2 keeps it as httpMetadata). */
const CRL_CONTENT_TYPE = "application/pkix-crl";

/**
 * The call's one `publish` log line (plan §4.3, implementation §2.6). A field that is not known when
 * the call ends is left out (undefined): a CRL that does not parse has no kind, one rejected before
 * the target is resolved no targetId. null is a known absence (a CRL without a CRL Number). Open
 * like the HTTP layer's LogRecord, so that its logger can be passed as deps.log.
 */
export interface PublishLogRecord {
  [field: string]: unknown;
  level: "info" | "warn" | "error";
  msg: "publish";
  targetId?: string;
  kind?: CrlKind;
  /** created / updated / unchanged; on a failure `reason` instead. */
  outcome?: PublishedCrl["outcome"];
  /** The error code, or `internal` when publishCrl threw. */
  reason?: PublishErrorCode | "internal";
  sha256?: string;
  crlNumber?: string | null;
  thisUpdate?: string;
  /** nextUpdate has passed (accepted, plan §6). */
  expired?: boolean;
  /** How often the state was read and the target resolved: 1 + retries, 0 before readState. */
  attempts: number;
  ms: number;
  /** Why, in English, for a failure (exception text included); never in a response. */
  detail?: string;
}

export interface PublishDeps {
  store: ObjectStore;
  now: () => Date;
  /** Backoff between catalog write attempts; realSleep when omitted. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives exactly one record per call (the HTTP route passes its structured logger). */
  log: (record: PublishLogRecord) => void;
}

/** created / updated wrote `current`; unchanged found the same bytes current and wrote nothing. */
export interface PublishedCrl {
  outcome: "created" | "updated" | "unchanged";
  targetId: string;
  kind: CrlKind;
  /** The issuer the target's config names, whose key verified the signature. */
  issuer: string;
  /** The target's current record after the call: the one written, or the stored one (unchanged). */
  current: CurrentCrl;
  /** downloadPaths of the target in the config read by the deciding attempt. */
  downloads: string[];
}

/** The stored current CRL a 409 refers to (`details.current`). */
export interface CurrentVersion {
  sha256: string;
  crlNumber: string | null;
  thisUpdate: string;
}

/**
 * The failures (implementation §2.6), `details` as the envelope carries them. The route answers
 * 409 for stale_crl, conflict, non_orderable and concurrent_update and 422 for the others. There is
 * no issuer_mismatch: the issuer the target names verifies (owner answer 4 of slice 4).
 */
export type PublishFailure =
  | {
      error: "invalid_crl";
      details: { reason: PkiParseReason | "signature_algorithm_mismatch" };
    }
  | { error: "not_yet_valid"; details: { thisUpdate: string } }
  | {
      error: "unknown_critical_extension" | "scoped_crl_unsupported";
      /** serialNumber (uppercase hex) only for an entry extension. */
      details: { oid: string; serialNumber?: string };
    }
  /** No AKI keyIdentifier (owner answer 3), or no imported certificate with that SKI. */
  | { error: "issuer_not_found"; details: { reason: "missing_aki" } | { authorityKeyId: string } }
  /** `certificates`: the imported certificates with the AKI as SKI; no target of the kind names one. */
  | { error: "target_not_configured"; details: { kind: CrlKind; certificates: string[] } }
  | { error: "invalid_signature" | "unsupported_algorithm"; details: { algorithm: string } }
  | { error: "stale_crl" | "conflict" | "non_orderable"; details: { current: CurrentVersion } }
  | { error: "concurrent_update" };

export type PublishErrorCode = PublishFailure["error"];

export type PublishResult = PublishedCrl | PublishFailure;

/** What the log line knows so far; publish fills it in as it goes. */
interface Trace {
  targetId?: string;
  kind?: CrlKind;
  sha256?: string;
  crlNumber?: string | null;
  thisUpdate?: string;
  expired?: boolean;
  attempts: number;
  detail?: string;
}

interface ParsedCrl {
  der: Uint8Array;
  sha256: string;
  crl: CertificateRevocationList;
  summary: CrlSummary;
  /** keyIdentifier of the Authority Key Identifier; undefined without one. */
  aki: string | undefined;
}

// Steps 1–2: toDer (PEM label X509 CRL only) → strict parseCRL → summary (CRL Number, Delta CRL
// Indicator and Next CRL Publish validated, M2) and AKI. Every PkiParseError is invalid_crl with its
// reason. The summary is checked against the catalog format before anything is written.
async function parse(bytes: Uint8Array, trace: Trace): Promise<ParsedCrl | PkiParseError> {
  try {
    const der = toDer(bytes, "crl");
    const sha256 = await sha256Hex(der);
    trace.sha256 = sha256;
    const crl = parseCRL(der);
    const summary = await buildCrlSummary(crl, der);
    let aki: string | undefined;
    try {
      aki = getAuthorityKeyIdHex(crl.crlExtensions?.extensions);
    } catch (error) {
      throw new PkiParseError("crl", "extension_value", "Invalid Authority Key Identifier", {
        cause: error,
      });
    }
    // As for certificates (buildCertificateSummary): an empty key id identifies no key.
    if (aki === "") {
      throw new PkiParseError("crl", "extension_value", "Empty Authority Key Identifier");
    }
    const checked = CrlSummarySchema.safeParse(summary);
    if (!checked.success) {
      throw new PkiParseError("crl", "structure", "No catalog form for the summary", {
        cause: checked.error,
      });
    }
    return { der, sha256, crl, summary, aki };
  } catch (error) {
    if (error instanceof PkiParseError) {
      return error;
    }
    throw error;
  }
}

type Resolution =
  | { targetId: string; issuer: string }
  | {
      failure: Extract<PublishFailure, { error: "issuer_not_found" | "target_not_configured" }>;
      detail: string;
    };

/**
 * Step 5 (M3, M4, M23, C5): the certificates whose subjectKeyId is the AKI are the candidates; the
 * target is the config target of the CRL's kind whose issuer is one of them, and that issuer
 * verifies, whatever other certificates share its SKI (owner answer 4). V6 leaves at most one such
 * target; more than one means an out-of-band config.json and throws (500).
 */
function resolveTarget(state: State, aki: string | undefined, kind: CrlKind): Resolution {
  if (aki === undefined) {
    return {
      failure: { error: "issuer_not_found", details: { reason: "missing_aki" } },
      detail: "The CRL has no Authority Key Identifier keyIdentifier",
    };
  }
  const candidates = Object.entries(state.catalog.certificates)
    .filter(([, certificate]) => certificate.summary.subjectKeyId === aki)
    .map(([id]) => id)
    .sort();
  if (candidates.length === 0) {
    return {
      failure: { error: "issuer_not_found", details: { authorityKeyId: aki } },
      detail: `No imported certificate has the Subject Key Identifier ${aki}`,
    };
  }
  const targets = Object.entries(state.config?.targets ?? {}).filter(
    ([, target]) => target.kind === kind && candidates.includes(target.issuer)
  );
  const [found, ...more] = targets;
  if (found === undefined) {
    return {
      failure: { error: "target_not_configured", details: { kind, certificates: candidates } },
      detail: `No ${kind} target names certificate ${candidates.join(", ")}`,
    };
  }
  if (more.length > 0) {
    throw new Error(
      `config.json breaks rule V6: ${kind} targets ${targets.map(([id]) => id).join(", ")} ` +
        `have issuers with the Subject Key Identifier ${aki}`
    );
  }
  const [targetId, target] = found;
  return { targetId, issuer: target.issuer };
}

// Step 6: the issuer's DER by its catalog key. A missing blob (or one that no longer parses) is a
// broken store, not a bad upload: it throws (500).
async function verifyWithIssuer(
  store: ObjectStore,
  state: State,
  issuer: string,
  crl: CertificateRevocationList
): Promise<SignatureCheck> {
  const entry = state.catalog.certificates[issuer];
  if (entry === undefined) {
    throw new Error(`Certificate ${issuer} is not in the catalog`);
  }
  const object = await store.get(entry.key);
  if (object === null) {
    throw new Error(`The blob ${entry.key} of issuer ${issuer} is missing`);
  }
  return verifyCrlSignature(crl, parseCertificate(object.bytes).subjectPublicKeyInfo);
}

function currentVersion(current: CurrentCrl): CurrentVersion {
  return {
    sha256: current.sha256,
    crlNumber: current.summary.crlNumber,
    thisUpdate: current.summary.thisUpdate,
  };
}

async function publish(
  deps: PublishDeps,
  bytes: Uint8Array,
  now: Date,
  trace: Trace
): Promise<PublishResult> {
  const parsed = await parse(bytes, trace);
  if (parsed instanceof PkiParseError) {
    trace.detail = `${parsed.reason}: ${parsed.message}`;
    return { error: "invalid_crl", details: { reason: parsed.reason } };
  }
  const { der, sha256, crl, summary, aki } = parsed;
  // M6: a valid Delta CRL Indicator makes a delta (an invalid one was rejected above).
  const kind: CrlKind = summary.baseCrlNumber === null ? "full" : "delta";
  trace.kind = kind;
  trace.crlNumber = summary.crlNumber;
  trace.thisUpdate = summary.thisUpdate;

  // Step 3.
  const policy = checkCrlPolicy(crl, now);
  if (!policy.ok) {
    const { ok: _ok, detail, ...failure } = policy;
    trace.detail = detail;
    return failure;
  }
  trace.expired = policy.expired;

  // Steps 4–9 run once per attempt on the state read for it. The signature only depends on the
  // issuer's key (the id is the digest of its certificate), so a retry verifies again only when it
  // resolved another issuer. Blob and marker are create-only and immutable: each is put at most once
  // per call, and an existing one (precondition-failed) has the same bytes, or, for a marker an
  // earlier attempt or a concurrent publish wrote, records the same superseded version.
  const checks = new Map<string, SignatureCheck>();
  const written = new Set<string>();
  const putOnce = async (key: string, body: Uint8Array, contentType: string) => {
    if (!written.has(key)) {
      await deps.store.put(key, body, { ifNoneMatch: "*", contentType });
      written.add(key);
    }
  };
  const attempt = async (state: State): Promise<CatalogMutation<PublishResult>> => {
    trace.attempts++;
    const resolved = resolveTarget(state, aki, kind);
    if ("failure" in resolved) {
      trace.detail = resolved.detail;
      return { result: resolved.failure };
    }
    const { targetId, issuer } = resolved;
    trace.targetId = targetId;

    let check = checks.get(issuer);
    if (check === undefined) {
      check = await verifyWithIssuer(deps.store, state, issuer, crl);
      checks.set(issuer, check);
    }
    if (!check.ok) {
      trace.detail = `${check.algorithm}: ${check.detail ?? check.reason}`;
      return { result: { error: check.reason, details: { algorithm: check.algorithm } } };
    }

    // Step 7: terminal outcomes end the call without a write.
    const entry = state.catalog.targets[targetId];
    const current = entry?.current ?? null;
    const downloads = downloadPaths(state.config, { target: targetId });
    const freshness = compareFreshness(current, { sha256, summary });
    if (current !== null) {
      switch (freshness) {
        case "unchanged":
          return { result: { outcome: "unchanged", targetId, kind, issuer, current, downloads } };
        case "stale_crl":
        case "conflict":
        case "non_orderable": {
          const version = currentVersion(current);
          trace.detail =
            `${freshness} against the current CRL ${version.crlNumber ?? "without a number"} ` +
            `of ${version.thisUpdate}`;
          return { result: { error: freshness, details: { current: version } } };
        }
      }
    }

    // Step 8: the blob; step 9: the marker of the superseded current, then the catalog.
    const key = crlBlobKey(targetId, summary, sha256);
    await putOnce(key, der, CRL_CONTENT_TYPE);
    const publishedAt = now.toISOString();
    if (current !== null) {
      const marker: HistoryMarker = { ...current, supersededAt: publishedAt };
      await putOnce(
        crlHistoryKey(targetId, current.summary, current.sha256),
        encodeJson(marker),
        JSON_CONTENT_TYPE
      );
    }
    const record: CurrentCrl = {
      sha256,
      key,
      size: der.byteLength,
      publishedAt,
      verifier: issuer,
      // Whole: nothing of the previous summary is merged in.
      summary,
    };
    return {
      next: {
        ...state.catalog,
        targets: { ...state.catalog.targets, [targetId]: { ...entry, current: record } },
      },
      result: {
        outcome: current === null ? "created" : "updated",
        targetId,
        kind,
        issuer,
        current: record,
        downloads,
      },
    };
  };

  const update = await updateState(deps.store, attempt, { sleep: deps.sleep ?? realSleep });
  if ("error" in update) {
    trace.detail = `The catalog write was lost ${trace.attempts} times`;
    return { error: "concurrent_update" };
  }
  return update.result;
}

/**
 * Publishes one CRL (DER or a single X509 CRL PEM block; the format is recognized from the bytes)
 * to the target that the configuration binds to its issuer and kind (plan §5.5, slice 4 step 6):
 *
 * 1–3. toDer, strict parseCRL, CRL Number / Delta CRL Indicator / AKI values (M2), kind (M6), then
 *    checkCrlPolicy against the one `deps.now()` snapshot of the call.
 * 4–7. readState; the target (issuer_not_found with details.reason missing_aki or the AKI,
 *    target_not_configured); the signature with the target's issuer; compareFreshness. unchanged,
 *    stale_crl, conflict and non_orderable end the call here.
 * 8–9. The blob, create-only; the superseded current's history marker, create-only; catalog.json
 *    with ifMatch. A lost catalog write goes back to step 4 on re-read state after 250 / 500 /
 *    1000 ms (updateState); after 4 lost writes → concurrent_update.
 *
 * Every rejection and unchanged before a write leaves the store as it was (M9). A lost race leaves
 * this call's blob unreferenced, an orphan that is not history (C8), and possibly the marker of a
 * current that was really published. Exactly one `publish` record goes to deps.log per call, also
 * when the call throws (an invalid stored object, a missing issuer blob, a store error): then with
 * reason `internal`, and the error is rethrown for the route's 500.
 */
export async function publishCrl(deps: PublishDeps, bytes: Uint8Array): Promise<PublishResult> {
  const now = deps.now();
  const started = performance.now();
  const trace: Trace = { attempts: 0 };
  const line = (
    level: PublishLogRecord["level"],
    end: Pick<PublishLogRecord, "outcome" | "reason">
  ): PublishLogRecord => ({
    level,
    msg: "publish",
    targetId: trace.targetId,
    kind: trace.kind,
    ...end,
    sha256: trace.sha256,
    crlNumber: trace.crlNumber,
    thisUpdate: trace.thisUpdate,
    expired: trace.expired,
    attempts: trace.attempts,
    ms: Math.round((performance.now() - started) * 10) / 10,
    detail: trace.detail,
  });

  let result: PublishResult;
  try {
    result = await publish(deps, bytes, now, trace);
  } catch (error) {
    trace.detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    deps.log(line("error", { reason: "internal" }));
    throw error;
  }
  deps.log(
    "error" in result
      ? line("warn", { reason: result.error })
      : line("info", { outcome: result.outcome })
  );
  return result;
}
