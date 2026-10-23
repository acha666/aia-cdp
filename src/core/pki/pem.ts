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

/**
 * Length in bytes (the text is ASCII) of derToPem's output for `derSize` ≥ 1 bytes of DER, without
 * encoding them: the markers, the base64 body, one LF per 64-column line and the LFs after
 * the BEGIN and END lines. Downloads take a PEM HEAD's Content-Length from it, and the `-pem` ETag
 * stands for this exact format: a change to derToPem's line width or line ending must change the
 * ETag suffix as well.
 */
export function pemLength(derSize: number, markers: PemBlockMarkers): number {
  const base64 = 4 * Math.ceil(derSize / 3);
  return markers.begin.length + markers.end.length + base64 + Math.ceil(base64 / 64) + 2;
}

// Upload input. The format is always recognized from the bytes; the request's content type only
// gates 415. Storage keys and file names are never consulted, and a bundle is rejected instead of
// silently using its first block.

/** RFC 7468 label of each kind. */
const PEM_LABELS: Record<PkiKind, string> = { certificate: "CERTIFICATE", crl: "X509 CRL" };

// An encapsulation boundary: `-----BEGIN <label>-----` or `-----END <label>-----`.
const BOUNDARY = /-----(BEGIN|END) ([^\r\n]*?)-----/g;

// Canonical base64 once whitespace is removed: full quads (the length is checked apart), `=`
// padding only at the end. No repeated group: V8 runs one out of regexp stack on a body of a few
// MiB, which is below the upload limit.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

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

/** One TLV of a DER input: its identifier octet, where its contents start and where it ends. */
export interface Tlv {
  tag: number;
  start: number;
  contents: number;
  end: number;
}

/**
 * The TLV at `start`, ending by `limit`, read from its identifier and length octets alone: one
 * identifier octet (a tag number up to 30, enough for every TLV the callers read) and a definite
 * length in its shortest form. Undefined otherwise.
 */
export function readTlv(der: Uint8Array, start: number, limit: number): Tlv | undefined {
  const tag = der[start];
  const first = der[start + 1];
  // 0x80 is the indefinite form.
  if (tag === undefined || first === undefined || (tag & 0x1f) === 0x1f || first === 0x80) {
    return undefined;
  }
  let contents = start + 2;
  let length = first;
  if (first > 0x80) {
    // More than four length octets describe more than any input; a leading 00 is one too many.
    const count = first & 0x7f;
    if (count > 4 || contents + count > limit || der[contents] === 0) {
      return undefined;
    }
    length = 0;
    for (const octet of der.subarray(contents, contents + count)) {
      length = length * 256 + octet;
    }
    if (length < 0x80) {
      return undefined;
    }
    contents += count;
  }
  const end = contents + length;
  return end <= limit ? { tag, start, contents, end } : undefined;
}

/**
 * Whether `bytes` is one SEQUENCE TLV with a DER header spanning all of them: toDer's test for DER
 * input, shared with the CLI, which sends such a file as is and splits anything else that holds
 * PEM boundaries.
 */
export function isDerSequence(bytes: Uint8Array): boolean {
  const tlv = readTlv(bytes, 0, bytes.length);
  return tlv?.tag === 0x30 && tlv.end === bytes.length;
}

/**
 * The DER bytes of an uploaded certificate or CRL.
 *
 * - One SEQUENCE TLV with a DER header spanning exactly all bytes is DER and returned as is.
 * - Otherwise the bytes are decoded as UTF-8 (a BOM and text around the block are tolerated); if
 *   that contains `-----BEGIN `, it is PEM: every boundary must carry the kind's label
 *   (`pem_label`), there must be exactly one complete block (`pem_blocks`, also for a missing END
 *   line) and its body must be base64 (`pem_base64`).
 * - Anything else is returned as is, so the strict parser reports it (`der` / `trailing_bytes`).
 *
 * Throws PkiParseError with the given kind.
 */
export function toDer(bytes: Uint8Array, kind: PkiKind): Uint8Array {
  if (isDerSequence(bytes)) {
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
  if (body.length % 4 !== 0 || !BASE64.test(body)) {
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
