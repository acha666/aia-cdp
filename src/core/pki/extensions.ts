// Extension values that both the upload path and the detail views read: key identifiers and CRL
// numbers. An upload holds the certificate or CRL to DER but not the contents of its extension
// values (plan §6), so it reads them with readExtensionSchema; the detail views decode every value
// in strict DER (readExtensionDer). The readers below take the decoded value either way.
import type { BaseBlock } from "asn1js";
import type { Extension } from "pkijs";
import {
  DerReader,
  INTEGER,
  OCTET_STRING,
  context,
  contents,
  expectTag,
  readBigInt,
  readDer,
  readOne,
  sequenceOf,
} from "./der.ts";

/** The extension value as one element, BER let through (the upload path, plan §6). */
export const readExtensionSchema = (extension: Extension): BaseBlock =>
  readOne(extension.extnValue.valueBlock.valueHexView);

/** The extension value as one element in strict DER (the detail views). */
export const readExtensionDer = (extension: Extension): BaseBlock =>
  readDer(extension.extnValue.valueBlock.valueHexView);

/** SubjectKeyIdentifier ::= KeyIdentifier (a primitive OCTET STRING): its octets. */
export const readSubjectKeyId = (value: BaseBlock): Uint8Array =>
  contents(expectTag(value, OCTET_STRING));

/**
 * AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0], authorityCertIssuer [1] GeneralNames,
 * authorityCertSerialNumber [2] }, all OPTIONAL and IMPLICIT (RFC 5280 §4.2.1.1), nothing else:
 * the key id and serial number octets, and the GeneralName elements of the issuer.
 */
export function readAuthorityKeyId(value: BaseBlock) {
  const aki = new DerReader(value);
  const keyIdentifier = aki.optional(context(0), contents);
  const names = aki.optional(context(1), (issuer) => sequenceOf(issuer, context(1)));
  const serial = aki.optional(context(2), contents);
  aki.end();
  // GeneralName ::= CHOICE [0]–[8]: the detail views decode each name, uploads only check this.
  if (names?.some(({ idBlock }) => idBlock.tagClass !== 3 || idBlock.tagNumber > 8)) {
    throw new Error("Invalid GeneralName");
  }
  return { keyIdentifier, names, serial };
}

/**
 * The longest CRL Number (or Delta CRL Indicator) the service takes, in contents octets: RFC 5280
 * §5.2.3 forbids CRL issuers longer values.
 */
export const MAX_CRL_NUMBER_OCTETS = 20;

/**
 * A CRL Number or Delta CRL Indicator: one INTEGER (tag 2, not ENUMERATED), not negative, at most
 * MAX_CRL_NUMBER_OCTETS contents octets. Throws otherwise.
 */
export function readCRLInteger(value: BaseBlock): bigint {
  const integer = expectTag(value, INTEGER);
  if (contents(integer).length > MAX_CRL_NUMBER_OCTETS) {
    throw new Error(`CRL number longer than ${MAX_CRL_NUMBER_OCTETS} octets`);
  }
  const number = readBigInt(integer);
  if (number < 0n) {
    throw new Error("Negative CRL number");
  }
  return number;
}
