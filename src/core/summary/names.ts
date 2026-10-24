// How the X.509 detail shows a name: Name (the RDN sequence, its normalized fields and the RFC 4514
// string), and the GeneralName CHOICE with its text forms (otherName and the AD GUID, IP addresses
// and constraint ranges, directoryName). The GeneralName readers take strict DER through
// ../pki/der.ts, like the extension decoders in extensions.ts that call them.
import { BaseBlock, Set as Asn1Set } from "asn1js";
import * as pkijs from "pkijs";
import { blockHex, displayText, stringOf } from "../pki/asn1.ts";
import { OID_DICTIONARY, OTHER_NAME_TYPES } from "../pki/constants.ts";
import {
  OBJECT_IDENTIFIER,
  OCTET_STRING,
  SEQUENCE,
  DerReader,
  context,
  contents,
  expectTag,
  hasTag,
  explicit,
  readAscii,
  readOid,
  sequenceOf,
} from "../pki/der.ts";
import { toHex, toUpperHex } from "../digest.ts";
import type {
  AttributeTypeAndValue,
  AttributeValue,
  GeneralName,
  Name,
  RelativeDistinguishedName,
} from "./schemas.ts";
import { buildObjectIdentifier, isBlock } from "./primitives.ts";

// =============================================================================
// Names
// =============================================================================

const ENCODING_BY_TAG: Record<number, AttributeValue["encoding"]> = {
  12: "utf8String",
  18: "numericString",
  19: "printableString",
  20: "teletexString",
  22: "ia5String",
  26: "visibleString",
  27: "generalString",
  28: "universalString",
  30: "bmpString",
};

/** RFC 4514 §2.4 escaping for a single attribute value. */
export function escapeRdnValue(value: string): string {
  let escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/[,+"<>;]/g, (char) => `\\${char}`)
    .replace(/\0/g, "\\00");
  if (escaped.startsWith("#") || escaped.startsWith(" ")) {
    escaped = `\\${escaped}`;
  }
  if (escaped.endsWith(" ") && !escaped.endsWith("\\ ")) {
    escaped = `${escaped.slice(0, -1)}\\ `;
  }
  return escaped;
}

function attributeLabel(oid: string): string {
  const entry = OID_DICTIONARY[oid];
  return entry?.short ?? entry?.name ?? oid;
}

function formatRfc4514(rdnSequence: RelativeDistinguishedName[]): string {
  return [...rdnSequence]
    .reverse()
    .map((rdn) =>
      rdn.attributes
        .map((attribute) => {
          const label = attributeLabel(attribute.type.oid);
          const value =
            attribute.value.string !== null
              ? escapeRdnValue(attribute.value.string)
              : `#${(attribute.value.rawHex ?? "").toLowerCase()}`;
          return `${label}=${value}`;
        })
        .join("+")
    )
    .join(",");
}

/** One AttributeTypeAndValue ::= SEQUENCE { type, value ANY }; the value need not be a string. */
function buildAttribute(schema: BaseBlock): AttributeTypeAndValue {
  const tv = new pkijs.AttributeTypeAndValue({ schema });
  const block: unknown = tv.value;
  const tagNumber =
    block instanceof BaseBlock && block.idBlock.tagClass === 1 ? block.idBlock.tagNumber : -1;
  const value: AttributeValue = {
    string: stringOf(block) ?? null,
    encoding: ENCODING_BY_TAG[tagNumber] ?? "unknown",
  };
  if (value.string === null && isBlock(block)) {
    value.rawHex = blockHex(block);
  }
  return { type: buildObjectIdentifier(tv.type), value };
}

export function buildName(name: pkijs.RelativeDistinguishedNames): Name {
  const rdnSequence = name.toSchema().valueBlock.value.map((group): RelativeDistinguishedName => {
    if (!(group instanceof Asn1Set)) {
      throw new Error("Invalid RDN set");
    }
    return { attributes: group.valueBlock.value.map(buildAttribute) };
  });

  // The normalized fields: the first string value of each attribute type, in RDN order.
  const attributes = rdnSequence.flatMap((rdn) => rdn.attributes);
  const first = (oid: string) =>
    attributes.find((a) => a.type.oid === oid && a.value.string !== null)?.value.string ?? null;
  return {
    commonName: first("2.5.4.3"),
    organization: first("2.5.4.10"),
    organizationalUnit: first("2.5.4.11"),
    country: first("2.5.4.6"),
    stateOrProvince: first("2.5.4.8"),
    locality: first("2.5.4.7"),
    rdnSequence,
    rfc4514: formatRfc4514(rdnSequence),
  };
}

// =============================================================================
// General names
// =============================================================================

/** 16 octets in the GUID text form, whose first three fields are little-endian. */
function formatGuid(bytes: Uint8Array): string {
  const le = (start: number, end: number) => toHex(bytes.slice(start, end).reverse());
  const hex = toHex(bytes);
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const GENERAL_NAME_TYPES: Record<number, GeneralName["type"]> = {
  0: "otherName",
  1: "rfc822Name",
  2: "dNSName",
  3: "x400Address",
  4: "directoryName",
  5: "ediPartyName",
  6: "uniformResourceIdentifier",
  7: "iPAddress",
  8: "registeredID",
};

/** OtherName ::= SEQUENCE { type-id OBJECT IDENTIFIER, value [0] EXPLICIT ANY }, under [0]. */
export function readOtherNameParts(block: BaseBlock): { typeOid: string; inner: BaseBlock } {
  const other = new DerReader(block, context(0));
  const typeOid = readOid(other.read(OBJECT_IDENTIFIER));
  const inner = explicit(other.read(context(0)), context(0));
  other.end();
  return { typeOid, inner };
}

/** The AD object GUID of a domain controller certificate: 16 octets, shown as a GUID. */
const AD_GUID = "1.3.6.1.4.1.311.25.1";

function readOtherName(block: BaseBlock): GeneralName {
  const { typeOid, inner } = readOtherNameParts(block);
  const bytes = hasTag(inner, OCTET_STRING) ? contents(inner) : undefined;
  return {
    type: "otherName",
    value:
      stringOf(inner) ??
      (typeOid === AD_GUID && bytes?.length === 16 ? formatGuid(bytes) : displayText(inner)),
    typeOid,
    typeName: OTHER_NAME_TYPES[typeOid],
    rawHex: blockHex(inner),
  };
}

function formatIpAddress(bytes: Uint8Array): string | undefined {
  if (bytes.length === 4) {
    return bytes.join(".");
  }
  if (bytes.length !== 16) {
    return undefined;
  }
  // Eight groups of four hex digits; the WHATWG URL host serializer writes them in RFC 5952 form.
  const groups = toHex(bytes).replace(/(.{4})(?=.)/g, "$1:");
  return new URL(`http://[${groups}]`).hostname.slice(1, -1);
}

/** The prefix length of a contiguous netmask (ones, then zeros); undefined for any other mask. */
function prefixLength(mask: Uint8Array): number | undefined {
  const bits = Array.from(mask, (byte) => byte.toString(2).padStart(8, "0")).join("");
  return /^(1*)0*$/.exec(bits)?.[1]?.length;
}

/** iPAddress is 4/16 bytes in alternative names and 8/32 bytes (address + mask) in constraints. */
function formatIpGeneralName(bytes: Uint8Array): { value: string; rawHex?: string } {
  const plain = formatIpAddress(bytes);
  if (plain) {
    return { value: plain };
  }
  if (bytes.length === 8 || bytes.length === 32) {
    const half = bytes.length / 2;
    const address = formatIpAddress(bytes.subarray(0, half)) ?? "";
    const mask = bytes.subarray(half);
    const prefix = prefixLength(mask);
    return {
      value: prefix === undefined ? `${address}/${formatIpAddress(mask)}` : `${address}/${prefix}`,
    };
  }
  const hex = toUpperHex(bytes);
  return { value: hex, rawHex: hex };
}

/** GeneralName ::= CHOICE, read from its context-tagged element (RFC 5280 §4.2.1.6). */
export function readGeneralName(block: BaseBlock): GeneralName {
  const type =
    block.idBlock.tagClass === 3 ? GENERAL_NAME_TYPES[block.idBlock.tagNumber] : undefined;
  switch (type) {
    case "otherName":
      return readOtherName(block);
    case "rfc822Name":
    case "dNSName":
    case "uniformResourceIdentifier":
      return { type, value: readAscii(block) };
    case "registeredID":
      return { type, value: readOid(block) };
    case "directoryName": {
      // Name is a CHOICE, so explicitly tagged.
      const schema = expectTag(explicit(block, context(4)), SEQUENCE);
      return { type, value: buildName(new pkijs.RelativeDistinguishedNames({ schema })).rfc4514 };
    }
    case "iPAddress":
      return { type, ...formatIpGeneralName(contents(block)) };
    case "x400Address":
    case "ediPartyName":
      // IMPLICIT SEQUENCEs with no useful text form; the DER is kept.
      if (!block.idBlock.isConstructed) {
        throw new Error("Invalid GeneralName");
      }
      return { type, value: "", rawHex: blockHex(block) };
    default:
      throw new Error("Invalid GeneralName");
  }
}

/** GeneralNames ::= SEQUENCE SIZE (1..MAX) OF GeneralName, possibly implicitly tagged. */
export const readGeneralNames = (block: BaseBlock, tag = SEQUENCE) =>
  sequenceOf(block, tag).map(readGeneralName);

/** RelativeDistinguishedName ::= SET SIZE (1..MAX) OF AttributeTypeAndValue, under [1] IMPLICIT. */
export function readRelativeName(block: BaseBlock): RelativeDistinguishedName {
  return { attributes: sequenceOf(block, context(1)).map(buildAttribute) };
}
