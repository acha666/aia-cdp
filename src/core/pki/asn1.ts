/**
 * Generic ASN.1 helpers that do not depend on PKIjs object models:
 * strict DER and RFC 5280 time validation, and a bounded, flat structure dump.
 */

import {
  BaseBlock,
  BitString,
  Boolean as Asn1Boolean,
  GeneralizedTime,
  Integer,
  Null,
  ObjectIdentifier,
  OctetString,
  UTCTime,
  fromBER,
} from "asn1js";
import { KNOWN_OID_NAMES } from "./constants.ts";
import { toUpperHex } from "../digest.ts";

export type Asn1TimeType = "utcTime" | "generalizedTime";

export interface StrictTime {
  type: Asn1TimeType;
  raw: string;
  date: Date;
}

export interface Asn1Line {
  depth: number;
  tag: string;
  length: number;
  value?: string;
}

/**
 * Thrown by readStrictTime, and by assertWellFormed for a UTCTime / GeneralizedTime that asn1js
 * could not decode. Parsers report it as `details.reason = "time"`; any other decoder error is a
 * DER error.
 */
export class Asn1TimeError extends Error {
  override name = "Asn1TimeError";
}

/** One character per octet (ISO 8859-1): the text of an IA5String, a time or an SID. */
export function asciiOf(view: Uint8Array): string {
  let text = "";
  for (const byte of view) {
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * The UTC date of these fields. Not Date.UTC: it reads the years 0–99 as 1900–1999 (a
 * GeneralizedTime can hold 0000–0099; 1900 is no leap year, 0000 is).
 */
function utcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

/**
 * Decode a UTCTime/GeneralizedTime block from fromBER in the only form RFC 5280 permits
 * (Zulu, whole seconds, fixed width). Anything else is rejected instead of being silently
 * normalized by the ASN.1 library.
 */
export function readStrictTime(block: BaseBlock): StrictTime {
  // asn1js derives GeneralizedTime from UTCTime, so this admits both.
  if (!(block instanceof UTCTime)) {
    throw new Asn1TimeError("ASN.1 value is not a time");
  }
  const isUtc = !(block instanceof GeneralizedTime);
  const raw = asciiOf(block.valueBlock.valueHexView);
  // asn1js has read the text into its fields (UTCTime years pivoted at 50), looser forms too. Only
  // the canonical form round-trips: a fraction, an offset or a missing field is not written back,
  // and a field out of range rolls the date over.
  const { year, month, day, hour, minute, second } = block;
  const date = utcDate(year, month - 1, day, hour, minute, second);
  let canonical: string | undefined;
  try {
    canonical = formatGeneralizedTime(date).slice(isUtc ? 2 : 0);
  } catch {
    // Rolled over to a year outside 0000–9999.
  }
  if (block.error !== "" || canonical !== raw) {
    throw new Asn1TimeError(`Invalid ASN.1 time: ${JSON.stringify(raw)}`);
  }
  return { type: isUtc ? "utcTime" : "generalizedTime", raw, date };
}

/**
 * The RFC 5280 GeneralizedTime text of `date`: `YYYYMMDDHHMMSSZ` in UTC, fractional seconds
 * dropped (certificate and CRL times are whole seconds). Fixed width, so lexicographic order is
 * time order: CRL blob keys sort by thisUpdate (plan §5.1). Throws RangeError for an invalid date
 * or a year outside 0000–9999, which the format cannot hold.
 */
export function formatGeneralizedTime(date: Date): string {
  // toISOString throws RangeError for an invalid date and writes ±YYYYYY outside 0000–9999.
  const iso = date.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(iso);
  if (!match) {
    throw new RangeError(`No GeneralizedTime for ${iso}`);
  }
  return `${match.slice(1).join("")}Z`;
}

/**
 * The value of an INTEGER (or ENUMERATED, an asn1js Integer) as a number, read from its contents
 * octets: asn1js's valueDec is 0 from four contents octets on (2^23 and up), and PKIjs copies
 * valueDec into its numeric fields. Throws a RangeError beyond Number.MAX_SAFE_INTEGER in either
 * direction, which a number cannot hold exactly; a detail builder reports that as a parse error.
 */
export function integerNumber(block: Integer): number {
  const value = block.toBigInt();
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) {
    throw new RangeError("INTEGER is beyond Number.MAX_SAFE_INTEGER");
  }
  return Number(value);
}

function children(block: BaseBlock): BaseBlock[] {
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  return Array.isArray(value)
    ? value.filter((item: unknown): item is BaseBlock => item instanceof BaseBlock)
    : [];
}

const UNIVERSAL = 1;
const BOOLEAN = 1;
const INTEGER = 2;
const BIT_STRING = 3;
const OBJECT_IDENTIFIER = 6;
const ENUMERATED = 10;
const SEQUENCE = 16;
const SET = 17;

/** Universal types whose contents have at least one octet (X.690 §8.2.1, 8.3.1, 8.6.2, 8.19). */
const NON_EMPTY = new Set([BOOLEAN, INTEGER, BIT_STRING, OBJECT_IDENTIFIER, ENUMERATED]);

// asn1js decodes BER and only warns, if at all, about what DER forbids, and re-encodes what it
// decoded in DER. Re-encoding the unsigned outer SEQUENCE of a certificate this way keeps the TBS
// and the signature intact, so without these checks one certificate could be imported under
// several ids.
function derProblem(block: BaseBlock): string | undefined {
  const { idBlock, lenBlock } = block;
  // toBER writes the identifier octets in their shortest form; isHexOnly is a tag number asn1js
  // could not read (more than 9 identifier octets).
  if (idBlock.isHexOnly || idBlock.blockLength !== idBlock.toBER(true).byteLength) {
    return "tag not in its shortest form";
  }
  if (lenBlock.isIndefiniteForm) {
    return "indefinite length";
  }
  // asn1js warns on a definite length only for a leading 00 and for the long form below 128: the
  // two forms longer than the shortest one.
  if (lenBlock.warnings.length > 0) {
    return "length not in its shortest form";
  }
  if (idBlock.tagClass === UNIVERSAL) {
    // DER uses the primitive form for strings (§10.2); X.509 has no other constructed types.
    if (idBlock.isConstructed && idBlock.tagNumber !== SEQUENCE && idBlock.tagNumber !== SET) {
      return "constructed encoding of a primitive type";
    }
    if (!idBlock.isConstructed && NON_EMPTY.has(idBlock.tagNumber) && lenBlock.length === 0) {
      return "empty contents";
    }
  }
  return undefined;
}

/**
 * Strict DER: reject decoder errors, BER that DER forbids, and time values that decoded into
 * garbage. PKIjs copies decoded dates without checking them, which turns malformed input into
 * real-looking timestamps (year 1899 and similar).
 *
 * Only the structure is walked: the children of constructed values. asn1js also decodes the
 * contents of every primitive OCTET STRING and BIT STRING on speculation; for extension values,
 * key ids, hashes, keys and signatures that is not checked (an SKI starting with 17 12 decodes as
 * a broken UTCTime).
 */
export function assertWellFormed(root: BaseBlock): void {
  const stack: BaseBlock[] = [root];
  while (stack.length > 0) {
    const block = stack.pop();
    if (!block) {
      continue;
    }
    const isTime = block instanceof UTCTime || block instanceof GeneralizedTime;
    if (block.error) {
      // asn1js only flags a time it cannot convert (UTCTime without seconds, an offset instead of
      // Z): report it as a time error, not as a DER error.
      const ErrorType = isTime ? Asn1TimeError : Error;
      throw new ErrorType(`ASN.1 decode error: ${block.error}`);
    }
    const problem = derProblem(block);
    if (problem !== undefined) {
      throw new Error(`Not DER: ${problem} (${tagLabel(block)})`);
    }
    if (isTime) {
      readStrictTime(block);
    }
    if (block.idBlock.isConstructed) {
      // Not push(...children): a spread of some 250 000 arguments overflows the call stack.
      for (const child of children(block)) {
        stack.push(child);
      }
    }
  }
}

function tagLabel(block: BaseBlock): string {
  const { tagClass, tagNumber, isConstructed } = block.idBlock;
  switch (tagClass) {
    case 1: {
      // fromBER decodes each universal type it knows into its own class, the rest into these two.
      const name = (block.constructor as typeof BaseBlock).NAME;
      return name === "PRIMITIVE" || name === "CONSTRUCTED" ? `UNIVERSAL ${tagNumber}` : name;
    }
    case 2:
      return `APPLICATION ${tagNumber}`;
    case 3:
      return isConstructed ? `[${tagNumber}]` : `[${tagNumber}] PRIMITIVE`;
    default:
      return `PRIVATE ${tagNumber}`;
  }
}

const MAX_VALUE_CHARS = 256;

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function describeOid(oid: string): string {
  const name = KNOWN_OID_NAMES[oid];
  return name ? `${oid} (${name})` : oid;
}

/** Human-readable scalar for a primitive block; undefined for constructed values. */
function primitiveText(block: BaseBlock): string | undefined {
  if (block.idBlock.isConstructed) {
    return undefined;
  }
  if (block instanceof Asn1Boolean) {
    return block.valueBlock.value ? "TRUE" : "FALSE";
  }
  // ENUMERATED too (an asn1js Integer). Not valueDec: it is 0 from four contents octets on.
  if (block instanceof Integer) {
    return block.toBigInt().toString(10);
  }
  if (block instanceof ObjectIdentifier) {
    return describeOid(block.valueBlock.toString());
  }
  if (block instanceof Null) {
    return undefined;
  }
  if (block instanceof UTCTime || block instanceof GeneralizedTime) {
    try {
      return readStrictTime(block).date.toISOString();
    } catch {
      return clip(asciiOf(block.valueBlock.valueHexView));
    }
  }
  if (block instanceof BitString) {
    const unused = block.valueBlock.unusedBits;
    const hex = toUpperHex(block.valueBlock.valueHexView);
    return clip(unused > 0 ? `${hex} (${unused} unused bits)` : hex);
  }
  if (block instanceof OctetString) {
    return clip(toUpperHex(block.valueBlock.valueHexView));
  }
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  if (typeof value === "string") {
    return clip(value);
  }
  const view = (block.valueBlock as { valueHexView?: Uint8Array }).valueHexView;
  return clip(toUpperHex(view ?? block.toBER(false)));
}

const DUMP_LIMITS = { maxLines: 200, maxDepth: 12 };

/**
 * Flat `openssl asn1parse`-style listing of a DER value. Returns undefined when
 * the bytes are not decodable, so callers fall back to raw hex.
 */
export function dumpAsn1(bytes: Uint8Array | ArrayBuffer): Asn1Line[] | undefined {
  let parsed: ReturnType<typeof fromBER>;
  try {
    parsed = fromBER(bytes);
  } catch {
    // asn1js throws instead of reporting some malformed values (a GeneralizedTime string).
    return undefined;
  }
  if (parsed.offset === -1 || parsed.result.error !== "") {
    return undefined;
  }
  const lines: Asn1Line[] = [];
  const visit = (block: BaseBlock, depth: number): void => {
    if (lines.length >= DUMP_LIMITS.maxLines) {
      return;
    }
    const value = primitiveText(block);
    const line: Asn1Line = { depth, tag: tagLabel(block), length: block.valueBlock.blockLength };
    if (value !== undefined) {
      line.value = value;
    }
    lines.push(line);
    if (depth < DUMP_LIMITS.maxDepth) {
      for (const child of children(block)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(parsed.result, 0);
  return lines;
}

/** Uppercase hex of the whole encoding of `block` (as asn1js re-encodes it). */
export function blockHex(block: BaseBlock): string {
  return toUpperHex(block.toBER(false));
}

/** Best-effort text for an arbitrary ASN.1 value (used for attribute values and qualifiers). */
export function displayText(block: BaseBlock): string {
  return primitiveText(block) ?? blockHex(block);
}
