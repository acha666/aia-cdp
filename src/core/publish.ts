// CRL publishing (plan §5.5): blob and history keys, the freshness rule and publishCrl. There is
// one commit point, the catalog write: no PEM or alias companions, no edge cache. The HTTP route
// maps the result.
import { encodeJson, JSON_CONTENT_TYPE, realSleep, updateState } from "./catalog.ts";
import type { CatalogMutation, CrlKind, CurrentCrl, State } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { formatGeneralizedTime } from "./pki/asn1.ts";
import { checkCrlPolicy, checkEntryPolicy } from "./pki/crl-policy.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { getAuthorityKeyIdHex, parseCertificate, parseCRL, parseCrlHeader } from "./pki/parsers.ts";
import type { ReceivedCrl } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { verifyCrlSignature } from "./pki/verify.ts";
import type { SignatureCheck } from "./pki/verify.ts";
import { downloadPaths } from "./resources.ts";
import type { ObjectStore } from "./store.ts";
import { buildCrlSummary, readCrlFields } from "./summary/catalog-summary.ts";
import type { CrlFields, CrlSummary } from "./summary/catalog-summary.ts";

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
 * Body of a history marker written when a publish supersedes `current`: that record verbatim. No
 * time of its own: a marker is create-only and may come from a call whose catalog write was then
 * lost (concurrent_update) while the version stayed current, so a time written then would stay
 * wrong forever. When the version was superseded is the `publishedAt` of the version that
 * superseded it.
 */
export type HistoryMarker = CurrentCrl;

// Freshness ---------------------------------------------------------------------------------------

/** What compareFreshness reads of a CRL: the catalog `current` record has this shape. */
export interface FreshnessInput {
  sha256: string;
  summary: Pick<CrlSummary, "crlNumber" | "thisUpdate">;
}

/** created / updated publish; the other four end the upload without a write. */
export type Freshness =
  "created" | "unchanged" | "updated" | "stale_crl" | "conflict" | "non_orderable";

/**
 * Whether `incoming` may replace the target's `current` CRL, from the catalog summaries alone,
 * never the current DER:
 *
 * 0. no current → created;
 * 1. same sha256 → unchanged;
 * 2. a CRL Number on exactly one side → non_orderable;
 * 3. numbers on both sides: higher → updated, lower → stale_crl, equal → row 4;
 * 4. equal numbers or none on either side, by thisUpdate: later → updated, the same instant →
 *    conflict (other bytes for the same CRL), earlier → stale_crl.
 *
 * Numbers compare as BigInt and times as epoch milliseconds, never as strings (a time with and one
 * without milliseconds are the same instant). nextUpdate plays no part, and a full and a delta
 * target are compared separately (AD CS numbers both from one counter, so each sequence has gaps).
 * The inputs are in the catalog format: decimal numbers and ISO 8601 times.
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
    const order = BigInt(after) - BigInt(before);
    if (order !== 0n) {
      return order > 0n ? "updated" : "stale_crl";
    }
  }
  const order = Date.parse(incoming.summary.thisUpdate) - Date.parse(current.summary.thisUpdate);
  if (order === 0) {
    return "conflict";
  }
  return order > 0 ? "updated" : "stale_crl";
}

// publishCrl --------------------------------------------------------------------------------------

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
  /** How often the state was read: 1 + retries; 0 when toDer rejected the bytes. */
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
  /**
   * The issuer the target's config names, whose key verified the signature (not again for
   * unchanged bytes).
   */
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
 * 409 for stale_crl, conflict, non_orderable and concurrent_update and 422 for the others.
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
  /** No AKI keyIdentifier, or no imported certificate with that SKI. */
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

/** A failure and the log line's detail of it. */
interface Rejection {
  failure: PublishFailure;
  detail: string;
}

/** Every PkiParseError is invalid_crl with its reason. */
function invalidCrl(error: PkiParseError): Rejection {
  return {
    failure: { error: "invalid_crl", details: { reason: error.reason } },
    detail: `${error.reason}: ${error.message}`,
  };
}

/** What the header of an upload says, checked before its signature is verified. */
interface Header {
  /** parseCrlHeader's CRL: no revoked entries, `tbsView` the TBSCertList as received. */
  crl: ReceivedCrl;
  fields: CrlFields;
  kind: CrlKind;
  /** keyIdentifier of the Authority Key Identifier; undefined without one. */
  aki: string | undefined;
}

// parseCrlHeader → readCrlFields (CRL Number, Delta CRL Indicator) and the AKI → kind →
// checkCrlPolicy against the call's one `now`.
function checkHeader(der: Uint8Array, now: Date, trace: Trace): Header | Rejection {
  let crl: ReceivedCrl;
  let fields: CrlFields;
  let aki: string | undefined;
  try {
    crl = parseCrlHeader(der);
    fields = readCrlFields(crl);
    try {
      aki = getAuthorityKeyIdHex(crl.crlExtensions?.extensions);
    } catch (error) {
      throw new PkiParseError("crl", "extension_value", "Invalid Authority Key Identifier", {
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof PkiParseError) {
      return invalidCrl(error);
    }
    throw error;
  }
  // A valid Delta CRL Indicator makes a delta (an invalid one was rejected above).
  const kind: CrlKind = fields.baseCrlNumber === null ? "full" : "delta";
  trace.kind = kind;
  trace.crlNumber = fields.crlNumber;
  trace.thisUpdate = fields.thisUpdate;

  const policy = checkCrlPolicy(crl, now);
  if (!policy.ok) {
    const { ok: _ok, detail, ...failure } = policy;
    return { failure, detail };
  }
  trace.expired = policy.expired;
  return { crl, fields, kind, aki };
}

// The whole CRL, once its signature verified: the strict parseCRL, checkEntryPolicy and the
// summary with revokedCount.
async function checkWhole(der: Uint8Array): Promise<CrlSummary | Rejection> {
  try {
    const crl = parseCRL(der);
    const policy = checkEntryPolicy(crl);
    if (!policy.ok) {
      const { ok: _ok, detail, ...failure } = policy;
      return { failure, detail };
    }
    return await buildCrlSummary(crl, der);
  } catch (error) {
    if (error instanceof PkiParseError) {
      return invalidCrl(error);
    }
    throw error;
  }
}

/**
 * The configured target whose current CRL has the digest `sha256`, as an unchanged result: these
 * bytes are answered without being parsed.
 */
function alreadyCurrent(state: State, sha256: string): PublishedCrl | undefined {
  for (const [targetId, target] of Object.entries(state.config?.targets ?? {})) {
    const current = state.catalog.targets[targetId]?.current;
    if (current?.sha256 === sha256) {
      const downloads = downloadPaths(state.config, { target: targetId });
      return {
        outcome: "unchanged",
        targetId,
        kind: target.kind,
        issuer: target.issuer,
        current,
        downloads,
      };
    }
  }
  return undefined;
}

type Resolution =
  | { targetId: string; issuer: string }
  | {
      failure: Extract<PublishFailure, { error: "issuer_not_found" | "target_not_configured" }>;
      detail: string;
    };

/**
 * The certificates whose subjectKeyId is the AKI are the candidates; the target is the config
 * target of the CRL's kind whose issuer is one of them, and that issuer verifies, whatever other
 * certificates share its SKI. V6 leaves at most one such target; more than one means an out-of-band
 * config.json and throws (500).
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

// The issuer's DER by its catalog key. A missing blob (or one that no longer parses) is a broken
// store, not a bad upload: it throws (500).
async function verifyWithIssuer(
  store: ObjectStore,
  state: State,
  issuer: string,
  crl: ReceivedCrl
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
  let der: Uint8Array;
  try {
    der = toDer(bytes, "crl");
  } catch (error) {
    if (error instanceof PkiParseError) {
      const { failure, detail } = invalidCrl(error);
      trace.detail = detail;
      return failure;
    }
    throw error;
  }
  const sha256 = await sha256Hex(der);
  trace.sha256 = sha256;

  // Each attempt runs on the state read for it. Header and whole CRL do not depend on the state:
  // each is checked at most once per call. The signature only depends on the issuer's key (the id
  // is the digest of its certificate), so a retry verifies again only when it resolved another
  // issuer. Blob and marker are create-only and immutable: each is put at most once per call, and
  // an existing one (precondition-failed) has the same bytes: the blob key holds its digest, and a
  // marker is the superseded current record, which every writer reads alike.
  let header: Header | Rejection | undefined;
  let whole: CrlSummary | Rejection | undefined;
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
    // What an earlier attempt learned does not describe this one: fields the call does not know
    // at its end are left out.
    delete trace.targetId;
    delete trace.detail;
    const unchanged = alreadyCurrent(state, sha256);
    if (unchanged !== undefined) {
      trace.targetId = unchanged.targetId;
      trace.kind = unchanged.kind;
      trace.crlNumber = unchanged.current.summary.crlNumber;
      trace.thisUpdate = unchanged.current.summary.thisUpdate;
      return { result: unchanged };
    }

    header ??= checkHeader(der, now, trace);
    if ("failure" in header) {
      trace.detail = header.detail;
      return { result: header.failure };
    }
    const { crl, fields, kind, aki } = header;
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

    // Terminal outcomes end the call without a write.
    const entry = state.catalog.targets[targetId];
    const current = entry?.current ?? null;
    const downloads = downloadPaths(state.config, { target: targetId });
    const freshness = compareFreshness(current, { sha256, summary: fields });
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

    whole ??= await checkWhole(der);
    if ("failure" in whole) {
      trace.detail = whole.detail;
      return { result: whole.failure };
    }
    const summary = whole;

    // The blob, the marker of the superseded current, then the catalog.
    const key = crlBlobKey(targetId, summary, sha256);
    await putOnce(key, der, CRL_CONTENT_TYPE);
    const publishedAt = now.toISOString();
    if (current !== null) {
      const marker: HistoryMarker = current;
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

/** The longest `detail` of a log line: it can quote the upload (a PEM label, a hex dump). */
const MAX_DETAIL_CHARS = 500;

/**
 * Publishes one CRL (DER or a single X509 CRL PEM block; the format is recognized from the bytes)
 * to the target that the configuration binds to its issuer and kind (plan §5.5). Bytes that are
 * not verified are never decoded whole: the most an upload costs before its signature is checked
 * is its body, one digest, the decoding of its header (at most 16 KiB) and the signature check.
 *
 * 1. toDer and the SHA-256 of the DER.
 * 2. readState. Bytes that are the current CRL of a configured target → unchanged, unparsed.
 * 3. parseCrlHeader (the CRL without its revoked entries), CRL Number / Delta CRL Indicator / AKI
 *    values, kind, then checkCrlPolicy against the one `deps.now()` snapshot of the call.
 * 4. The target (issuer_not_found with details.reason missing_aki or the AKI,
 *    target_not_configured); the signature with the target's issuer over the TBSCertList as
 *    received; compareFreshness. stale_crl, conflict and non_orderable end the call here.
 * 5. Only on the way to created or updated: the strict parseCRL of the whole CRL (invalid_crl with
 *    its reason), checkEntryPolicy and the summary.
 * 6. The blob, create-only; the superseded current's history marker, create-only; catalog.json
 *    with ifMatch. A lost catalog write goes back to step 2 on re-read state after 250 / 500 /
 *    1000 ms (updateState); after 4 lost writes → concurrent_update.
 *
 * Every rejection and unchanged before a write leaves the store as it was. A lost race leaves this
 * call's blob unreferenced, an orphan that is not history, and possibly the marker of a current
 * that was really published. Exactly one `publish` record goes to deps.log per call, also
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
    detail: trace.detail?.slice(0, MAX_DETAIL_CHARS),
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
