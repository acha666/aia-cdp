import { BaseBlock, GeneralizedTime, Integer, UTCTime, fromBER } from "asn1js";
import type { Extension } from "pkijs";

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
  const parsed = fromBER(view);
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

export function readCRLInteger(extension: Extension): bigint {
  const integer = readExtensionValue(extension, Integer);
  if (integer.idBlock.tagNumber !== 2 || integer.valueBlock.valueHexView.length === 0) {
    throw new Error(`Invalid CRL number in ${extension.extnID}`);
  }
  const value = integer.toBigInt();
  if (value < 0n) {
    throw new Error(`Negative CRL number in ${extension.extnID}`);
  }
  return value;
}
