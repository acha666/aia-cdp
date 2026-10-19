import { PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";

export interface PemBlockMarkers {
  begin: string;
  end: string;
}

export const PEM_BLOCK_MARKERS = {
  certificate: {
    begin: "-----BEGIN CERTIFICATE-----",
    end: "-----END CERTIFICATE-----",
  },
  crl: {
    begin: "-----BEGIN X509 CRL-----",
    end: "-----END X509 CRL-----",
  },
} as const;

export function extractPEMBlock(pemText: string, begin: string, end: string): Uint8Array {
  const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`, "g");
  const matches = pemText.match(pattern);
  if (!matches || matches.length === 0) {
    throw new Error(`PEM block not found: ${begin} ... ${end}`);
  }
  const block = matches[0];
  const base64Body = block
    .replace(begin, "")
    .replace(end, "")
    .replace(/[\r\n\s]/g, "");
  const binary = atob(base64Body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function derToPem(
  bytes: ArrayBuffer | Uint8Array,
  beginMarker: string,
  endMarker: string
): string {
  const binaryBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Bound argument counts for large CRLs and preserve typed-array slice boundaries.
  const chunks: string[] = [];
  for (let offset = 0; offset < binaryBytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...binaryBytes.subarray(offset, offset + 0x8000)));
  }
  const base64 = btoa(chunks.join(""));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `${beginMarker}\n${lines.join("\n")}\n${endMarker}\n`;
}

// Upload input (M7, plan §10 #13). The format is always recognized from the bytes; the request's
// content type only gates 415. Storage keys are never consulted (the old helper went by a `.pem`
// key suffix), and a bundle is rejected instead of silently using its first block.

/** RFC 7468 label of each kind. */
const PEM_LABELS: Record<PkiKind, string> = { certificate: "CERTIFICATE", crl: "X509 CRL" };

// An encapsulation boundary: `-----BEGIN <label>-----` or `-----END <label>-----`.
const BOUNDARY = /-----(BEGIN|END) ([^\r\n]*?)-----/g;

// Canonical base64 once whitespace is removed: full quads, `=` padding only at the end.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface Boundary {
  type: "BEGIN" | "END";
  label: string;
  /** Offsets of the boundary line in the text: [start, end). */
  start: number;
  end: number;
}

function boundariesOf(text: string): Boundary[] {
  return Array.from(text.matchAll(BOUNDARY), (match) => ({
    type: match[1] === "BEGIN" ? "BEGIN" : "END",
    label: match[2] ?? "",
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Total length (header + content) of the outer TLV when `bytes` starts with a definite-length
 * SEQUENCE header; undefined otherwise (wrong tag, indefinite or oversized length, too short).
 */
function sequenceLength(bytes: Uint8Array): number | undefined {
  const first = bytes[1];
  if (bytes[0] !== 0x30 || first === undefined) {
    return undefined;
  }
  if (first < 0x80) {
    return 2 + first;
  }
  const count = first & 0x7f;
  if (count === 0 || count > 4 || bytes.length < 2 + count) {
    return undefined;
  }
  let length = 0;
  for (const byte of bytes.subarray(2, 2 + count)) {
    length = length * 256 + byte;
  }
  return 2 + count + length;
}

/**
 * The DER bytes of an uploaded certificate or CRL.
 *
 * - A SEQUENCE whose outer TLV spans exactly all bytes is DER and returned as is.
 * - Otherwise the bytes are decoded as UTF-8 (a BOM and text around the block are tolerated); if
 *   that contains `-----BEGIN `, it is PEM: every boundary must carry the kind's label
 *   (`pem_label`), there must be exactly one complete block (`pem_blocks`, also for a missing END
 *   line) and its body must be base64 (`pem_base64`).
 * - Anything else is returned as is, so the strict parser reports it (`der` / `trailing_bytes`).
 *
 * Throws PkiParseError with the given kind.
 */
export function toDer(bytes: Uint8Array, kind: PkiKind): Uint8Array {
  if (sequenceLength(bytes) === bytes.length) {
    return bytes;
  }
  // Both options spelled out: the Workers types declare them as required. Not fatal: only the
  // text around the block may be in another encoding, the boundaries and base64 are ASCII.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  if (!text.includes("-----BEGIN ")) {
    return bytes;
  }
  const label = PEM_LABELS[kind];
  const boundaries = boundariesOf(text);
  const other = boundaries.find((boundary) => boundary.label !== label);
  if (other) {
    throw new PkiParseError(
      kind,
      "pem_label",
      `Unexpected PEM label ${JSON.stringify(other.label)}`
    );
  }
  const [begin, end] = boundaries;
  if (boundaries.length !== 2 || begin?.type !== "BEGIN" || end?.type !== "END") {
    throw new PkiParseError(kind, "pem_blocks", `Expected exactly one complete ${label} PEM block`);
  }
  const body = text.slice(begin.end, end.start).replace(/\s/g, "");
  if (!BASE64.test(body)) {
    throw new PkiParseError(kind, "pem_base64", `Invalid base64 in the ${label} PEM block`);
  }
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

/**
 * The complete blocks of the kind's label in a PEM bundle, in order, each as its own PEM text (the
 * CLI imports `chain.pem` one block per request). Blocks with other labels (a private key, a CRL in
 * a certificate bundle) are skipped and never sent. A BEGIN without its END, or an END without a
 * BEGIN, throws PkiParseError `pem_blocks`: a truncated bundle is not imported partially. The
 * bodies are not checked here; toDer does that for each block.
 */
export function splitPemBlocks(text: string, kind: PkiKind): string[] {
  const label = PEM_LABELS[kind];
  const blocks: string[] = [];
  let open: Boundary | undefined;
  for (const boundary of boundariesOf(text)) {
    if (boundary.label !== label) {
      continue;
    }
    if (boundary.type === "BEGIN" && open === undefined) {
      open = boundary;
    } else if (boundary.type === "END" && open !== undefined) {
      blocks.push(`${text.slice(open.start, boundary.end)}\n`);
      open = undefined;
    } else {
      throw new PkiParseError(kind, "pem_blocks", `Unbalanced ${label} PEM boundaries`);
    }
  }
  if (open !== undefined) {
    throw new PkiParseError(kind, "pem_blocks", `${label} PEM block without an END line`);
  }
  return blocks;
}
