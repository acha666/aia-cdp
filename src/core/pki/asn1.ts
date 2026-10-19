/**
 * Generic ASN.1 helpers that do not depend on PKIjs object models:
 * strict RFC 5280 time validation and a bounded, flat structure dump.
 */

import {
  BaseBlock,
  BitString,
  Boolean as Asn1Boolean,
  Enumerated,
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

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return { type: isUtc ? "utcTime" : "generalizedTime", raw, date };
}

function children(block: BaseBlock): BaseBlock[] {
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  return Array.isArray(value)
    ? value.filter((item: unknown): item is BaseBlock => item instanceof BaseBlock)
    : [];
}

/**
 * Reject structures whose time values decoded into garbage or that carry
 * decoder errors. PKIjs copies decoded dates without checking them, which
 * turns malformed input into real-looking timestamps (year 1899 and similar).
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
    if (isTime) {
      readStrictTime(block);
    }
    stack.push(...children(block));
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
  if (block instanceof Integer) {
    return block.valueBlock.valueHexView.length <= 6
      ? String(block.valueBlock.valueDec)
      : block.toBigInt().toString(10);
  }
  if (block instanceof Enumerated) {
    return String(block.valueBlock.valueDec);
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
