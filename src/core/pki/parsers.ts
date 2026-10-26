import { fromBER } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import { Asn1TimeError, assertWellFormed, readStrictTime } from "./asn1.ts";
import { DerReader, INTEGER, SEQUENCE, context, readInteger } from "./der.ts";
import { messageOf, PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";
import {
  plainExtension,
  readAuthorityKeyId,
  readCRLInteger,
  readExtensionSchema,
  readSubjectKeyId,
} from "./extensions.ts";
import type { PlainExtension } from "./extensions.ts";
import { encodeTlv, readTlv } from "./pem.ts";
import type { Tlv } from "./pem.ts";
import { toHex } from "../digest.ts";

const LABELS: Record<PkiKind, string> = { certificate: "certificate", crl: "CRL" };

// Strict DER: one top-level element, no decoder errors, RFC 5280 times. A Uint8Array may be a view
// into a larger buffer: asn1js decodes the view, so the end offset is compared with the view's
// byteLength, never the buffer's (whatever surrounds the view is not part of the input).
// asn1js's default limits (10 000 nodes, 16 MiB of contents, 100 levels) apply unless `limits` says
// otherwise.
function decodeDer(der: ArrayBuffer | Uint8Array, kind: PkiKind, limits?: { maxDepth: number }) {
  const label = LABELS[kind];
  let asn1: ReturnType<typeof fromBER>;
  try {
    asn1 = fromBER(der, limits);
  } catch (error) {
    // asn1js throws instead of reporting some malformed values (a GeneralizedTime string).
    throw new PkiParseError(kind, "der", `Bad ${label} DER: ${String(error)}`, { cause: error });
  }
  if (asn1.offset === -1) {
    throw new PkiParseError(kind, "der", `Bad ${label} DER: ${asn1.result.error}`);
  }
  if (asn1.offset !== der.byteLength) {
    throw new PkiParseError(kind, "trailing_bytes", `Bad ${label} DER: trailing bytes`);
  }
  try {
    assertWellFormed(asn1.result);
  } catch (error) {
    throw new PkiParseError(
      kind,
      error instanceof Asn1TimeError ? "time" : "der",
      `Bad ${label} DER: ${messageOf(error)}`,
      { cause: error }
    );
  }
  return asn1.result;
}

/**
 * The octets of the two AlgorithmIdentifiers of a certificate or CRL as received (asn1js's
 * valueBeforeDecodeView, a view of its copy of the input, like PKIjs's own tbsView). RFC 5280
 * §4.1.1.2 and §5.1.1.2: they must be the same. Import and the upload policy compare these: the
 * outer one is outside the signature, so anyone holding the file can rewrite it, and comparing
 * re-encodings would hide what asn1js normalizes.
 */
export interface ReceivedAlgorithms {
  /** The outer signatureAlgorithm of the Certificate / CertificateList, outside the signature. */
  signatureAlgorithmView: Uint8Array;
  /** The signature field of the TBSCertificate / TBSCertList. */
  signatureView: Uint8Array;
}

/** A certificate from parseCertificate: PKIjs's object plus its AlgorithmIdentifiers as received. */
export interface ReceivedCertificate extends pkijs.Certificate, ReceivedAlgorithms {}

/** A CRL from parseCrlHeader: PKIjs's object plus its AlgorithmIdentifiers as received. */
export interface ReceivedCrl extends pkijs.CertificateRevocationList, ReceivedAlgorithms {}

/** Whether the outer signatureAlgorithm and the TBS signature are the same octets (OID and parameters). */
export function sameSignatureAlgorithms(received: ReceivedAlgorithms): boolean {
  const { signatureAlgorithmView: outer, signatureView: inner } = received;
  return (
    outer.byteLength === inner.byteLength && outer.every((octet, index) => octet === inner[index])
  );
}

/**
 * What PKIjs's object for `schema` (accepted as `kind`) does not hold as received: the octets of
 * both AlgorithmIdentifiers, and the version as a number, undefined when absent (v1, PKIjs's
 * default). PKIjs copies asn1js's valueDec for the version, which is 0 from four contents octets
 * on. Throws for a version beyond Number.MAX_SAFE_INTEGER.
 */
function receivedFields(
  kind: PkiKind,
  schema: BaseBlock
): ReceivedAlgorithms & { version: number | undefined } {
  const outer = new DerReader(schema);
  const tbs = new DerReader(outer.read(SEQUENCE));
  let version: BaseBlock | undefined;
  if (kind === "certificate") {
    // TBSCertificate: version [0] EXPLICIT, then serialNumber.
    const tagged = tbs.optional(context(0));
    version = tagged && new DerReader(tagged, context(0)).read(INTEGER);
    tbs.read(INTEGER);
  } else {
    // TBSCertList: an optional version INTEGER first.
    version = tbs.optional(INTEGER);
  }
  return {
    version: version && readInteger(version),
    signatureView: tbs.read(SEQUENCE).valueBeforeDecodeView,
    signatureAlgorithmView: outer.read(SEQUENCE).valueBeforeDecodeView,
  };
}

/**
 * PKIjs's object for `schema` plus its received fields. PKIjs throws when the decoded tree does not
 * match its schema (a CRL given as a certificate): a structure error, like a version out of range.
 */
function construct<T extends pkijs.Certificate | pkijs.CertificateRevocationList>(
  kind: PkiKind,
  schema: BaseBlock,
  build: () => T
): T & ReceivedAlgorithms {
  try {
    const object = build();
    const { version, ...views } = receivedFields(kind, schema);
    object.version = version ?? object.version;
    return Object.assign(object, views);
  } catch (error) {
    throw new PkiParseError(
      kind,
      "structure",
      `Bad ${LABELS[kind]} structure: ${messageOf(error)}`,
      { cause: error }
    );
  }
}

/** Throws PkiParseError (kind "certificate", reason der / trailing_bytes / time / structure). */
export function parseCertificate(der: ArrayBuffer | Uint8Array): ReceivedCertificate {
  const schema = decodeDer(der, "certificate");
  return construct("certificate", schema, () => new pkijs.Certificate({ schema }));
}

function crlOf(schema: BaseBlock): ReceivedCrl {
  return construct("crl", schema, () => new pkijs.CertificateRevocationList({ schema }));
}

const SEQUENCE_TAG = 0x30;
const UTC_TIME_TAG = 0x17;
const GENERALIZED_TIME_TAG = 0x18;
const CRL_EXTENSIONS_TAG = 0xa0;

// A CRL without its entries is the issuer name, the times, a few extensions and the signature: well
// under 4 KiB for any real CA. The cap keeps the decoding before the signature check small.
const MAX_HEADER_BYTES = 16 * 1024;

/** The TLVs that fill the contents of `parent` exactly; more than `max` is a structure error. */
function fieldsOf(der: Uint8Array, parent: Tlv, max: number): Tlv[] {
  const fields: Tlv[] = [];
  let at = parent.contents;
  while (at < parent.end) {
    const field = readTlv(der, at, parent.end);
    if (field === undefined) {
      throw new PkiParseError("crl", "der", "Bad CRL DER: a field is not one DER TLV");
    }
    if (fields.length === max) {
      throw new PkiParseError("crl", "structure", `Bad CRL structure: more than ${max} fields`);
    }
    fields.push(field);
    at = field.end;
  }
  return fields;
}

/**
 * The CRL in `der` without its revoked entries, for the checks an upload passes before its
 * signature is verified: those entries are only split off by their TLV header, never decoded.
 * The outer SEQUENCE must be DER and span `der` exactly, filled by exactly its three fields; the
 * revokedCertificates of the TBSCertList is the SEQUENCE after thisUpdate or nextUpdate. A
 * CertificateList re-assembled from every other field, octet for octet, must fit in 16 KiB and then
 * goes through the strict decoding, which must read the same fields. `tbsView` is the TBSCertList
 * as received, entries included, which the signature covers; `revokedCertificates` is undefined.
 * Throws PkiParseError like parseCRL.
 */
export function parseCrlHeader(der: Uint8Array): ReceivedCrl {
  return splitCrl(der).crl;
}

/** parseCrlHeader's CRL and the TLV of its revokedCertificates, undefined when the list is absent. */
function splitCrl(der: Uint8Array): { crl: ReceivedCrl; revoked: Tlv | undefined } {
  const outer = readTlv(der, 0, der.length);
  if (outer === undefined) {
    throw new PkiParseError("crl", "der", "Bad CRL DER: not one definite-length DER TLV");
  }
  if (outer.end !== der.length) {
    throw new PkiParseError("crl", "trailing_bytes", "Bad CRL DER: trailing bytes");
  }
  const [tbs, ...unsigned] = outer.tag === SEQUENCE_TAG ? fieldsOf(der, outer, 3) : [];
  if (tbs?.tag !== SEQUENCE_TAG || unsigned.length !== 2) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: not SEQUENCE { SEQUENCE, signatureAlgorithm, signatureValue }"
    );
  }
  const fields = fieldsOf(der, tbs, 7);
  const revoked = fields.findIndex(
    (field, index) =>
      field.tag === SEQUENCE_TAG &&
      [UTC_TIME_TAG, GENERALIZED_TIME_TAG].includes(fields[index - 1]?.tag ?? 0)
  );
  // The header is read without the list, so a field after it but crlExtensions would take its
  // place there (a nextUpdate, a second list) where the whole CRL fails PKIjs's schema.
  if (revoked !== -1 && ![undefined, CRL_EXTENSIONS_TAG].includes(fields[revoked + 1]?.tag)) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: a field other than crlExtensions after revokedCertificates"
    );
  }
  const octets = (tlv: Tlv) => der.subarray(tlv.start, tlv.end);
  const header = encodeTlv(SEQUENCE_TAG, [
    encodeTlv(SEQUENCE_TAG, fields.filter((_, index) => index !== revoked).map(octets)),
    ...unsigned.map(octets),
  ]);
  if (header.byteLength > MAX_HEADER_BYTES) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: more than 16 KiB besides the entries"
    );
  }
  const schema = decodeDer(header, "crl");
  // asn1js reads the elements of a constructed value as far as its input goes, not only as far as
  // the value: a field whose elements overrun it makes asn1js read other fields than the split
  // above (a revoked list among them, whose entries parseCRL would then skip).
  const tbsFields = new DerReader(new DerReader(schema).read(SEQUENCE)).rest(0);
  const overruns = ({ idBlock, lenBlock, valueBlock }: BaseBlock) =>
    idBlock.isConstructed && valueBlock.blockLength !== lenBlock.length;
  if (tbsFields.some(overruns)) {
    throw new PkiParseError("crl", "der", "Bad CRL DER: a field's elements overrun it");
  }
  const crl = crlOf(schema);
  crl.tbsView = octets(tbs);
  return { crl, revoked: fields[revoked] };
}

/** A revoked entry from parseCRL as plain values: its asn1js tree is not kept. */
export interface CrlEntry {
  /** The contents octets of userCertificate. */
  serial: Uint8Array;
  revocationDate: pkijs.Time;
  /** [] when crlEntryExtensions is absent. */
  extensions: PlainExtension[];
}

/** A CRL from parseCRL: parseCrlHeader's CRL plus every revoked entry in order, [] for none. */
export interface WholeCrl extends ReceivedCrl {
  entries: CrlEntry[];
}

/** One entry of revokedCertificates (its TLV), decoded in strict DER on its own. */
function readEntry(der: Uint8Array): CrlEntry {
  // An entry sits three levels below the CertificateList (TBSCertList, revokedCertificates).
  const schema = decodeDer(der, "crl", { maxDepth: 97 });
  let entry: pkijs.RevokedCertificate;
  try {
    entry = new pkijs.RevokedCertificate({ schema });
  } catch (error) {
    throw new PkiParseError("crl", "structure", `Bad CRL structure: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return {
    serial: entry.userCertificate.valueBlock.valueHexView,
    revocationDate: entry.revocationDate,
    extensions: entry.crlEntryExtensions?.extensions.map(plainExtension) ?? [],
  };
}

/**
 * The whole CRL, every revoked entry included. Throws PkiParseError (kind "crl", reason der /
 * trailing_bytes / time / structure). parseCrlHeader's checks come first; then each entry is
 * decoded on its own and kept as plain values, so that one entry's asn1js tree is alive at a time
 * (the tree of a whole CRL takes some 140 bytes of heap per octet). The entries still take far
 * more memory than the input, so this is only for a CRL whose signature verified or one already
 * stored; an upload is checked on parseCrlHeader first.
 */
export function parseCRL(der: Uint8Array): WholeCrl {
  const { crl, revoked } = splitCrl(der);
  const entries = revoked
    ? fieldsOf(der, revoked, Infinity).map((tlv) => readEntry(der.subarray(tlv.start, tlv.end)))
    : [];
  return Object.assign(crl, { entries });
}

/**
 * The Subject Key Identifier, lowercase hex; undefined without the extension. Throws when its value
 * is not exactly one primitive OCTET STRING.
 */
export function getSKIHex(cert: pkijs.Certificate): string | undefined {
  const extension = cert.extensions?.find((ext) => ext.extnID === "2.5.29.14");
  return extension && toHex(readSubjectKeyId(readExtensionSchema(extension)));
}

/**
 * keyIdentifier of the Authority Key Identifier in `extensions` (`cert.extensions` or
 * `crl.crlExtensions?.extensions`), lowercase hex; undefined without the extension or without a
 * keyIdentifier. Throws when the extension is present but malformed, trailing bytes included.
 */
export function getAuthorityKeyIdHex(
  extensions: pkijs.Extension[] | undefined
): string | undefined {
  const extension = extensions?.find((ext) => ext.extnID === "2.5.29.35");
  const key = extension && readAuthorityKeyId(readExtensionSchema(extension)).keyIdentifier;
  return key && toHex(key);
}

/** The INTEGER of the CRL extension `oid` (CRL Number, Delta CRL Indicator); undefined without it. */
export function getCRLInteger(
  crl: pkijs.CertificateRevocationList,
  oid: string
): bigint | undefined {
  const extension = crl.crlExtensions?.extensions.find((ext) => ext.extnID === oid);
  return extension && readCRLInteger(readExtensionSchema(extension));
}

/** AD CS Next CRL Publish: when the CA will publish its next CRL (before nextUpdate). */
export const NEXT_CRL_PUBLISH_OID = "1.3.6.1.4.1.311.21.4";

/**
 * The AD CS Next CRL Publish time: exactly one UTCTime / GeneralizedTime in the RFC 5280 form (AD
 * CS writes a UTCTime). Undefined without the extension, and also for a value that cannot be read
 * as such: the time only informs the CRL status, so it does not reject the CRL.
 */
export function getNextCRLPublish(crl: pkijs.CertificateRevocationList): Date | undefined {
  const extension = crl.crlExtensions?.extensions.find(
    (ext) => ext.extnID === NEXT_CRL_PUBLISH_OID
  );
  if (!extension) {
    return undefined;
  }
  try {
    return readStrictTime(readExtensionSchema(extension)).date;
  } catch {
    return undefined;
  }
}
