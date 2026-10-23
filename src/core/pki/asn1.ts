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
import { toHex } from "./conversion.ts";

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

const UTC_TIME_PATTERN = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;
const GENERALIZED_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;

function asciiOf(view: Uint8Array): string {
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
  hour = 0,
  minute = 0,
  second = 0
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

function daysInMonth(year: number, month: number): number {
  return utcDate(year, month, 0).getUTCDate();
}

/**
 * Decode a UTCTime/GeneralizedTime block in the only form RFC 5280 permits
 * (Zulu, whole seconds, fixed width). Anything else is rejected instead of
 * being silently normalized by the ASN.1 library.
 */
export function readStrictTime(block: BaseBlock): StrictTime {
  // asn1js derives GeneralizedTime from UTCTime, so test the subclass first.
  const isGeneralized = block instanceof GeneralizedTime;
  const isUtc = !isGeneralized && block instanceof UTCTime;
  if (!isUtc && !isGeneralized) {
    throw new Asn1TimeError("ASN.1 value is not a time");
  }
  const raw = asciiOf(block.valueBlock.valueHexView);
  const match = isUtc ? UTC_TIME_PATTERN.exec(raw) : GENERALIZED_TIME_PATTERN.exec(raw);
  if (!match) {
    throw new Asn1TimeError(`Invalid ASN.1 time: ${JSON.stringify(raw)}`);
  }
  // Both patterns have exactly six groups (noUncheckedIndexedAccess).
  const numbers = match.slice(1).map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const yearPart = numbers[0];
  const year = isUtc ? (yearPart >= 50 ? 1900 + yearPart : 2000 + yearPart) : yearPart;
  const [, month, day, hour, minute, second] = numbers;
  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  if (!valid) {
    throw new Asn1TimeError(`Invalid ASN.1 time: ${JSON.stringify(raw)}`);
  }
  const date = utcDate(year, month - 1, day, hour, minute, second);
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
    throw new RangeError(`INTEGER ${value} is beyond Number.MAX_SAFE_INTEGER`);
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

/** Identifier octets of a tag number: one up to 30, else one plus base-128 digits (X.690 §8.1.2). */
function identifierOctets(tagNumber: number): number {
  if (tagNumber < 31) {
    return 1;
  }
  let octets = 1;
  for (let rest = tagNumber; rest > 0; rest = Math.floor(rest / 128)) {
    octets++;
  }
  return octets;
}

/** Length octets of the definite form with the fewest octets (X.690 §10.1). */
function lengthOctets(length: number): number {
  if (length < 128) {
    return 1;
  }
  let octets = 1;
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets++;
  }
  return octets;
}

// asn1js decodes BER and only warns, if at all, about what DER forbids, and re-encodes what it
// decoded in DER. Re-encoding the unsigned outer SEQUENCE of a certificate this way keeps the TBS
// and the signature intact, so without these checks one certificate could be imported under
// several ids.
function derProblem(block: BaseBlock): string | undefined {
  const { idBlock, lenBlock } = block;
  if (idBlock.blockLength !== identifierOctets(idBlock.tagNumber)) {
    return "tag not in its shortest form";
  }
  if (lenBlock.isIndefiniteForm) {
    return "indefinite length";
  }
  if (lenBlock.blockLength !== lengthOctets(lenBlock.length)) {
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
 * Strict DER (M1): reject decoder errors, BER that DER forbids, and time values that decoded into
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

const UNIVERSAL_TAG_NAMES: Record<number, string> = {
  1: "BOOLEAN",
  2: "INTEGER",
  3: "BIT STRING",
  4: "OCTET STRING",
  5: "NULL",
  6: "OBJECT IDENTIFIER",
  7: "ObjectDescriptor",
  8: "EXTERNAL",
  9: "REAL",
  10: "ENUMERATED",
  12: "UTF8String",
  13: "RELATIVE-OID",
  16: "SEQUENCE",
  17: "SET",
  18: "NumericString",
  19: "PrintableString",
  20: "TeletexString",
  21: "VideotexString",
  22: "IA5String",
  23: "UTCTime",
  24: "GeneralizedTime",
  25: "GraphicString",
  26: "VisibleString",
  27: "GeneralString",
  28: "UniversalString",
  29: "CHARACTER STRING",
  30: "BMPString",
};

export function tagLabel(block: BaseBlock): string {
  const { tagClass, tagNumber, isConstructed } = block.idBlock;
  switch (tagClass) {
    case 1:
      return UNIVERSAL_TAG_NAMES[tagNumber] ?? `UNIVERSAL ${tagNumber}`;
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
export function primitiveText(block: BaseBlock): string | undefined {
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
    const hex = toHex(block.valueBlock.valueHexView).toUpperCase();
    return clip(unused > 0 ? `${hex} (${unused} unused bits)` : hex);
  }
  if (block instanceof OctetString) {
    return clip(toHex(block.valueBlock.valueHexView).toUpperCase());
  }
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  if (typeof value === "string") {
    return clip(value);
  }
  const view = (block.valueBlock as { valueHexView?: Uint8Array }).valueHexView;
  return clip(toHex(view ?? new Uint8Array(block.toBER(false))).toUpperCase());
}

const DUMP_LIMITS = { maxLines: 200, maxDepth: 12 };

/**
 * Flat `openssl asn1parse`-style listing of a DER value. Returns undefined when
 * the bytes are not decodable, so callers fall back to raw hex.
 */
export function dumpAsn1(bytes: Uint8Array | ArrayBuffer): Asn1Line[] | undefined {
  const parsed = fromBER(bytes);
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

/** Best-effort text for an arbitrary ASN.1 value (used for attribute values and qualifiers). */
export function displayText(block: BaseBlock): string {
  const text = primitiveText(block);
  if (text !== undefined) {
    return text;
  }
  return toHex(block.toBER(false)).toUpperCase();
}
