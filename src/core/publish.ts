// CRL publishing (plan §5.5): the freshness rule and publishCrl, which writes the blob and history
// marker keys of ./history.ts. There is one commit point, the catalog write: no PEM or alias
// companions, no edge cache. The HTTP route maps the result.
import { z } from "zod";
import { CrlSummarySchema, encodeJson, Sha256Hex, updateState } from "./catalog.ts";
import type {
  CatalogDeps,
  CatalogMutation,
  CrlKind,
  CrlSummary,
  CurrentCrl,
  State,
} from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { crlBlobKey, crlHistoryKey } from "./history.ts";
import type { HistoryMarker } from "./history.ts";
import { checkCrlPolicy, checkEntryPolicy } from "./pki/crl-policy.ts";
import type { CrlPolicyFailure } from "./pki/crl-policy.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { getAuthorityKeyIdHex, parseCertificate, parseCRL, parseCrlHeader } from "./pki/parsers.ts";
import type { ReceivedCrl } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { verifyCrlSignature } from "./pki/verify.ts";
import type { SignatureCheck, SignatureFailure } from "./pki/verify.ts";
import { downloadPaths } from "./resources.ts";
import { readBlob } from "./store.ts";
import type { ObjectStore } from "./store.ts";
import { buildCrlSummary, readCrlFields, readExtension } from "./summary/catalog-summary.ts";
import type { CrlFields } from "./summary/catalog-summary.ts";

// Freshness ---------------------------------------------------------------------------------------

/**
 * Whether `incoming` may replace the target's current CRL, from the catalog summaries alone, never
 * the current DER (bytes that are the current CRL were answered unchanged before, by
 * alreadyCurrent):
 *
 * 1. a CRL Number on exactly one side → non_orderable;
 * 2. numbers on both sides: higher → updated, lower → stale_crl, equal → row 3;
 * 3. equal numbers or none on either side, by thisUpdate: later → updated, the same instant →
 *    conflict (other bytes for the same CRL), earlier → stale_crl.
 *
 * Numbers compare as BigInt and times as epoch milliseconds, never as strings (a time with and one
 * without milliseconds are the same instant). nextUpdate plays no part, and a full and a delta
 * target are compared separately (AD CS numbers both from one counter, so each sequence has gaps).
 * The inputs are in the catalog format: decimal numbers and ISO 8601 times.
 */
export function compareFreshness(
  current: Pick<CrlSummary, "crlNumber" | "thisUpdate">,
  incoming: Pick<CrlSummary, "crlNumber" | "thisUpdate">
): "updated" | "stale_crl" | "conflict" | "non_orderable" {
  const before = current.crlNumber;
  const after = incoming.crlNumber;
  if ((before === null) !== (after === null)) {
    return "non_orderable";
  }
  if (before !== null && after !== null) {
    const order = BigInt(after) - BigInt(before);
    if (order !== 0n) {
      return order > 0n ? "updated" : "stale_crl";
    }
  }
  const order = Date.parse(incoming.thisUpdate) - Date.parse(current.thisUpdate);
  if (order === 0) {
    return "conflict";
  }
  return order > 0 ? "updated" : "stale_crl";
}

// publishCrl --------------------------------------------------------------------------------------

/** What the log line knows so far; publish fills it in as it goes. */
interface Trace {
  targetId?: string;
  kind?: CrlKind;
  sha256?: string;
  crlNumber?: string | null;
  thisUpdate?: string;
  /** nextUpdate has passed (accepted, plan §6). */
  expired?: boolean;
  /** How often the state was read: 1 + retries; 0 when toDer rejected the bytes. */
  attempts: number;
  /** Why, in English, for a failure (exception text included); never in a response. */
  detail?: string;
}

/**
 * The call's one `publish` log line (plan §4.3, implementation §2.6). A field that is not known when
 * the call ends is left out (undefined): a CRL that does not parse has no kind, one rejected before
 * the target is resolved no targetId. null is a known absence (a CRL without a CRL Number). Open
 * like the HTTP layer's LogRecord, so that its logger can be passed as deps.log.
 */
export interface PublishLogRecord extends Trace {
  [field: string]: unknown;
  level: "info" | "warn" | "error";
  msg: "publish";
  /** created / updated / unchanged; on a failure `reason` instead. */
  outcome?: PublishSuccess["outcome"];
  /** The error code, or `internal` when publishCrl threw. */
  reason?: PublishErrorCode | "internal";
  ms: number;
}

export interface PublishDeps extends CatalogDeps {
  now: () => Date;
  /** Receives exactly one record per call (the HTTP route passes AppDeps.log). */
  log: (record: PublishLogRecord) => void;
}

/** created / updated wrote `current`; unchanged found the same bytes current and kept it. */
export interface PublishSuccess {
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

/** The stored current CRL a 409 refers to (`details.current`; the HTTP schema uses this one). */
export const CurrentCrlVersion = z
  .object({
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
  })
  .meta({ id: "CurrentCrlVersion" });

export type CurrentVersion = z.infer<typeof CurrentCrlVersion>;

/**
 * The failures (implementation §2.6), `details` as the envelope carries them. The route answers
 * 409 for stale_crl, conflict, non_orderable and concurrent_update and 422 for the others.
 */
export type PublishFailure =
  | { error: "invalid_crl"; details: { reason: PkiParseReason } }
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

export type PublishResult = PublishSuccess | PublishFailure;

/**
 * A failure of the upload, thrown out of the attempt (which ends updateState without a write);
 * publishCrl's catch makes it the result, and its message the log line's detail.
 */
class Rejection extends Error {
  override name = "Rejection";
  readonly failure: PublishFailure;

  constructor(failure: PublishFailure, detail: string) {
    super(detail);
    this.failure = failure;
  }
}

function reject({ ok: _ok, detail, ...failure }: CrlPolicyFailure | SignatureFailure): never {
  throw new Rejection(failure, detail);
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
// checkCrlPolicy against the call's one `now`. A PkiParseError propagates (invalid_crl), and a
// policy violation is a Rejection.
function checkHeader(der: Uint8Array, now: Date, trace: Trace): Header {
  const crl = parseCrlHeader(der);
  const fields = readCrlFields(crl);
  const aki = readExtension("crl", "Authority Key Identifier", () =>
    getAuthorityKeyIdHex(crl.crlExtensions?.extensions)
  );
  // A valid Delta CRL Indicator makes a delta (an invalid one threw above).
  const kind: CrlKind = fields.baseCrlNumber === null ? "full" : "delta";
  trace.kind = kind;
  trace.crlNumber = fields.crlNumber;
  trace.thisUpdate = fields.thisUpdate;

  const policy = checkCrlPolicy(crl, now);
  if (!policy.ok) {
    reject(policy);
  }
  trace.expired = policy.expired;
  return { crl, fields, kind, aki };
}

// The whole CRL, once its signature verified: the strict parseCRL, checkEntryPolicy and the
// summary with revokedCount. A PkiParseError propagates (invalid_crl), and a policy violation is a
// Rejection.
async function checkWhole(der: Uint8Array): Promise<CrlSummary> {
  const crl = parseCRL(der);
  const policy = checkEntryPolicy(crl);
  if (!policy.ok) {
    reject(policy);
  }
  return buildCrlSummary(crl, der);
}

/**
 * The configured target whose current CRL has the digest `sha256`, as an unchanged result: these
 * bytes are answered without being parsed.
 */
function alreadyCurrent(state: State, sha256: string): PublishSuccess | undefined {
  for (const [targetId, target] of Object.entries(state.config.targets)) {
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

/**
 * The certificates whose subjectKeyId is the AKI are the candidates; the target is the config
 * target of the CRL's kind whose issuer is one of them, and that issuer verifies, whatever other
 * certificates share its SKI. V6 leaves at most one such target; more than one means an out-of-band
 * config.json and throws (500).
 */
function resolveTarget(
  state: State,
  aki: string | undefined,
  kind: CrlKind
): { targetId: string; issuer: string } {
  if (aki === undefined) {
    throw new Rejection(
      { error: "issuer_not_found", details: { reason: "missing_aki" } },
      "The CRL has no Authority Key Identifier keyIdentifier"
    );
  }
  const candidates = Object.entries(state.catalog.certificates)
    .filter(([, certificate]) => certificate.summary.subjectKeyId === aki)
    .map(([id]) => id)
    .sort();
  if (candidates.length === 0) {
    throw new Rejection(
      { error: "issuer_not_found", details: { authorityKeyId: aki } },
      `No imported certificate has the Subject Key Identifier ${aki}`
    );
  }
  const targets = Object.entries(state.config.targets).filter(
    ([, target]) => target.kind === kind && candidates.includes(target.issuer)
  );
  const [found, ...more] = targets;
  if (found === undefined) {
    throw new Rejection(
      { error: "target_not_configured", details: { kind, certificates: candidates } },
      `No ${kind} target names certificate ${candidates.join(", ")}`
    );
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
  const der = await readBlob(store, entry.key);
  return verifyCrlSignature(crl, parseCertificate(der).subjectPublicKeyInfo);
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
  const der = toDer(bytes, "crl");
  const sha256 = await sha256Hex(der);
  trace.sha256 = sha256;

  // Each attempt runs on the state read for it, and verifies the signature with the issuer it
  // resolved. Header and whole CRL do not depend on the state: each is checked at most once per
  // call. Blob and marker are create-only and immutable: each is put at most once per call, and an
  // existing one (precondition-failed) has the same bytes: the blob key holds its digest, and a
  // marker is the superseded current record, which every writer reads alike.
  let header: Header | undefined;
  let summary: CrlSummary | undefined;
  const written = new Set<string>();
  const putOnce = async (key: string, body: Uint8Array) => {
    if (!written.has(key)) {
      await deps.store.put(key, body, { ifNoneMatch: "*" });
      written.add(key);
    }
  };
  const attempt = async (state: State): Promise<CatalogMutation<PublishSuccess>> => {
    trace.attempts++;
    // What an earlier attempt learned does not describe this one: fields the call does not know
    // at its end are left out.
    delete trace.targetId;
    const unchanged = alreadyCurrent(state, sha256);
    if (unchanged !== undefined) {
      trace.targetId = unchanged.targetId;
      trace.kind = unchanged.kind;
      trace.crlNumber = unchanged.current.summary.crlNumber;
      trace.thisUpdate = unchanged.current.summary.thisUpdate;
      return { result: unchanged };
    }

    header ??= checkHeader(der, now, trace);
    const { crl, fields, kind, aki } = header;
    const { targetId, issuer } = resolveTarget(state, aki, kind);
    trace.targetId = targetId;

    const check = await verifyWithIssuer(deps.store, state, issuer, crl);
    if (!check.ok) {
      reject(check);
    }

    // Terminal outcomes end the call without a write (bytes already current were answered by
    // alreadyCurrent).
    const entry = state.catalog.targets[targetId];
    const current = entry?.current ?? null;
    const downloads = downloadPaths(state.config, { target: targetId });
    if (current !== null) {
      const freshness = compareFreshness(current.summary, fields);
      if (freshness !== "updated") {
        const version = currentVersion(current);
        throw new Rejection(
          { error: freshness, details: { current: version } },
          `${freshness} against the current CRL ${version.crlNumber ?? "without a number"} ` +
            `of ${version.thisUpdate}`
        );
      }
    }

    summary ??= await checkWhole(der);

    // The blob, the marker of the superseded current, then the catalog.
    const key = crlBlobKey(targetId, summary, sha256);
    await putOnce(key, der);
    const publishedAt = now.toISOString();
    if (current !== null) {
      const marker: HistoryMarker = current;
      await putOnce(crlHistoryKey(targetId, current.summary, current.sha256), encodeJson(marker));
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

  const update = await updateState(deps, attempt);
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
    ...trace,
    ...end,
    ms: Math.round((performance.now() - started) * 10) / 10,
    detail: trace.detail?.slice(0, MAX_DETAIL_CHARS),
  });

  let result: PublishResult;
  try {
    result = await publish(deps, bytes, now, trace);
  } catch (error) {
    // A Rejection is its failure. Every PkiParseError of the upload (toDer, the header, the whole
    // CRL) is invalid_crl with its reason; one of the issuer certificate is a broken store.
    if (error instanceof Rejection) {
      trace.detail = error.message;
      result = error.failure;
    } else if (error instanceof PkiParseError && error.kind === "crl") {
      trace.detail = `${error.reason}: ${error.message}`;
      result = { error: "invalid_crl", details: { reason: error.reason } };
    } else {
      trace.detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      deps.log(line("error", { reason: "internal" }));
      throw error;
    }
  }
  deps.log(
    "error" in result
      ? line("warn", { reason: result.error })
      : line("info", { outcome: result.outcome })
  );
  return result;
}
