import { BaseBlock, GeneralizedTime, Integer, UTCTime } from "asn1js";
import type { Extension } from "pkijs";
import { decodeBer } from "./asn1.ts";

/** PKIjs decodes and caches extension values; validate its result before using it. */
export function readExtensionValue<T>(
  extension: Extension,
  expected: abstract new (...args: never[]) => T
): T {
  const value: unknown = extension.parsedValue;
  if (
    !(value instanceof expected) ||
    (typeof value === "object" && value !== null && "parsingError" in value) ||
    (value instanceof BaseBlock && value.error !== "")
  ) {
    throw new Error(`Invalid extension ${extension.extnID}`);
  }
  return value;
}

/**
 * Decode the raw extension bytes as a fresh ASN.1 tree, independent of the PKIjs cache. The value
 * must be exactly one element (RFC 5280 §4.1: extnValue holds the DER of one value); PKIjs's own
 * decoding ignores trailing bytes.
 */
export function readExtensionSchema(extension: Extension): BaseBlock {
  const view = extension.extnValue.valueBlock.valueHexView;
  const parsed = decodeBer(view);
  if (parsed.offset !== view.byteLength || parsed.result.error !== "") {
    throw new Error(`Invalid extension ${extension.extnID}`);
  }
  return parsed.result;
}

export function readExtensionTime(extension: Extension): UTCTime | GeneralizedTime {
  const value: unknown = extension.parsedValue;
  if ((value instanceof UTCTime || value instanceof GeneralizedTime) && value.error === "") {
    return value;
  }
  throw new Error(`Invalid time in ${extension.extnID}`);
}

/**
 * The longest CRL Number (or Delta CRL Indicator) the service takes, in contents octets. RFC 5280
 * §5.2.3 allows conforming CAs 20; the service keeps no such limit (M2) but needs one: the number is
 * written in decimal into the blob and history marker names (plan §5.1), a file system allows a
 * name 255 octets, and the fs adapter writes through `.<name>.<uuid>.tmp`, 42 octets longer.
 * 48 octets is at most 2^383 − 1, 116 digits, so the longest name is 15 (thisUpdate) + 1 + 116 +
 * 1 + 64 (sha256) + 5 (`.json`) = 202 octets, and its temporary file 244.
 */
export const MAX_CRL_NUMBER_OCTETS = 48;

/**
 * A CRL Number or Delta CRL Indicator: exactly one INTEGER (tag 2, not ENUMERATED), not negative, at
 * most MAX_CRL_NUMBER_OCTETS contents octets. Throws otherwise, trailing bytes in extnValue included.
 */
export function readCRLInteger(extension: Extension): bigint {
  const integer = readExtensionSchema(extension);
  if (
    !(integer instanceof Integer) ||
    integer.idBlock.tagNumber !== 2 ||
    integer.valueBlock.valueHexView.length === 0
  ) {
    throw new Error(`Invalid CRL number in ${extension.extnID}`);
  }
  if (integer.valueBlock.valueHexView.length > MAX_CRL_NUMBER_OCTETS) {
    throw new Error(
      `CRL number in ${extension.extnID} longer than ${MAX_CRL_NUMBER_OCTETS} octets`
    );
  }
  const value = integer.toBigInt();
  if (value < 0n) {
    throw new Error(`Negative CRL number in ${extension.extnID}`);
  }
  return value;
}

/**
 * The first extension OID that occurs more than once in `extensions`, or undefined. X.509 allows
 * each extension once per Extensions (RFC 5280 §4.2 for certificates, likewise for CRLs), and every
 * reader here takes the first instance (`find`), so a repeated one would be silently ignored.
 */
export function repeatedExtension(
  extensions: readonly Extension[] | undefined
): string | undefined {
  const seen = new Set<string>();
  for (const { extnID } of extensions ?? []) {
    if (seen.has(extnID)) {
      return extnID;
    }
    seen.add(extnID);
  }
  return undefined;
}
