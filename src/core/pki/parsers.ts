import { Constructed, Integer, OctetString, Sequence } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import {
  Asn1TimeError,
  assertWellFormed,
  decodeBer,
  integerNumber,
  readStrictTime,
} from "./asn1.ts";
import { PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";
import { readCRLInteger, readExtensionSchema } from "./extensions.ts";
import { toHex } from "./conversion.ts";

const LABELS: Record<PkiKind, string> = { certificate: "certificate", crl: "CRL" };

// Strict DER (M1): one top-level element, no decoder errors, RFC 5280 times. A Uint8Array may be a
// view into a larger buffer: asn1js decodes the view, so the end offset is compared with its
// byteLength (the old callers passed `bytes.buffer` and decoded whatever surrounded the view).
function decodeDer(der: ArrayBuffer | Uint8Array, kind: PkiKind) {
  const label = LABELS[kind];
  const asn1 = decodeBer(der);
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
      `Bad ${label} DER: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return asn1.result;
}

// PKIjs throws when the decoded tree does not match its schema (a CRL given as a certificate).
function construct<T>(kind: PkiKind, build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new PkiParseError(
      kind,
      "structure",
      `Bad ${LABELS[kind]} structure: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * The version INTEGER of the TBS in `schema` (a decoded certificate or CRL that PKIjs accepted) as
 * a number; undefined when absent (v1, PKIjs's default). PKIjs copies asn1js's valueDec, which is 0
 * from four contents octets on, so the parsers overwrite PKIjs's version with this. A version
 * beyond Number.MAX_SAFE_INTEGER is a structure error.
 */
function versionOf(kind: PkiKind, schema: BaseBlock): number | undefined {
  const [tbs] = schema instanceof Sequence ? schema.valueBlock.value : [];
  const [first] = tbs instanceof Sequence ? tbs.valueBlock.value : [];
  // TBSCertificate: version [0] EXPLICIT; TBSCertList: an optional INTEGER first.
  const explicit = first instanceof Constructed && first.idBlock.tagClass === 3;
  const field = kind === "certificate" ? (explicit ? first.valueBlock.value[0] : undefined) : first;
  if (!(field instanceof Integer)) {
    return undefined;
  }
  try {
    return integerNumber(field);
  } catch (error) {
    throw new PkiParseError(kind, "structure", `Bad ${LABELS[kind]} version`, { cause: error });
  }
}

/**
 * The octets of the two AlgorithmIdentifiers of a certificate or CRL as received (asn1js's
 * valueBeforeDecodeView, a view of its copy of the input, like PKIjs's own tbsView). RFC 5280
 * §4.1.1.2 and §5.1.1.2: they must be the same. Import and the upload policy compare these (M11):
 * the outer one is outside the signature, so anyone holding the file can rewrite it, and comparing
 * re-encodings would hide what asn1js normalizes (slice 4 review C2).
 */
export interface ReceivedAlgorithms {
  /** The outer signatureAlgorithm of the Certificate / CertificateList, outside the signature. */
  signatureAlgorithmView: Uint8Array;
  /** The signature field of the TBSCertificate / TBSCertList. */
  signatureView: Uint8Array;
}

/** A certificate from parseCertificate: PKIjs's object plus its AlgorithmIdentifiers as received. */
export interface ReceivedCertificate extends pkijs.Certificate, ReceivedAlgorithms {}

/** A CRL from parseCRL: PKIjs's object plus its AlgorithmIdentifiers as received. */
export interface ReceivedCrl extends pkijs.CertificateRevocationList, ReceivedAlgorithms {}

/** Whether the outer signatureAlgorithm and the TBS signature are the same octets (OID and parameters). */
export function sameSignatureAlgorithms(received: ReceivedAlgorithms): boolean {
  const { signatureAlgorithmView: outer, signatureView: inner } = received;
  return (
    outer.byteLength === inner.byteLength && outer.every((octet, index) => octet === inner[index])
  );
}

/**
 * The first SEQUENCE of a constructed value: the TBS signature (the TBSCertList's version is an
 * INTEGER; the TBSCertificate's is [0] and its serialNumber an INTEGER).
 */
function firstSequence(block: BaseBlock | undefined): BaseBlock | undefined {
  return block instanceof Sequence
    ? block.valueBlock.value.find((child) => child instanceof Sequence)
    : undefined;
}

/** `schema`'s AlgorithmIdentifiers as received, once PKIjs accepted it as `kind`. */
function receivedAlgorithms(kind: PkiKind, schema: BaseBlock): ReceivedAlgorithms {
  // PKIjs accepted the shape: SEQUENCE { tbs SEQUENCE, signatureAlgorithm, signature }.
  const [tbs, outer] = schema instanceof Sequence ? schema.valueBlock.value : [];
  const inner = firstSequence(tbs);
  if (outer === undefined || inner === undefined) {
    throw new PkiParseError(
      kind,
      "structure",
      `Bad ${LABELS[kind]} structure: no AlgorithmIdentifier`
    );
  }
  return {
    signatureAlgorithmView: outer.valueBeforeDecodeView,
    signatureView: inner.valueBeforeDecodeView,
  };
}

/** Throws PkiParseError (kind "certificate", reason der / trailing_bytes / time / structure). */
export function parseCertificate(der: ArrayBuffer | Uint8Array): ReceivedCertificate {
  const schema = decodeDer(der, "certificate");
  const certificate = construct("certificate", () => new pkijs.Certificate({ schema }));
  certificate.version = versionOf("certificate", schema) ?? certificate.version;
  return Object.assign(certificate, receivedAlgorithms("certificate", schema));
}

/** Throws PkiParseError (kind "crl", reason der / trailing_bytes / time / structure). */
export function parseCRL(der: ArrayBuffer | Uint8Array): ReceivedCrl {
  const schema = decodeDer(der, "crl");
  const crl = construct("crl", () => new pkijs.CertificateRevocationList({ schema }));
  crl.version = versionOf("crl", schema) ?? crl.version;
  return Object.assign(crl, receivedAlgorithms("crl", schema));
}

/** The first CN in RDN order; undefined when absent or when its value is not a string type. */
export function getCommonName(name: pkijs.RelativeDistinguishedNames): string | undefined {
  const attribute = name.typesAndValues.find((value) => value.type === "2.5.4.3");
  const value: unknown = attribute?.value.valueBlock.value;
  return typeof value === "string" ? value : undefined;
}

export function getCN(cert: pkijs.Certificate): string | undefined {
  return getCommonName(cert.subject);
}

/**
 * The Subject Key Identifier, lowercase hex; undefined without the extension. Throws when its value
 * is not exactly one primitive OCTET STRING.
 */
export function getSKIHex(cert: pkijs.Certificate): string | undefined {
  const extension = cert.extensions?.find((ext) => ext.extnID === "2.5.29.14");
  if (!extension) {
    return undefined;
  }
  const value = readExtensionSchema(extension);
  if (!(value instanceof OctetString) || value.idBlock.isConstructed) {
    throw new Error("Invalid extension 2.5.29.14");
  }
  return toHex(value.valueBlock.valueHexView);
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
  if (!extension) {
    return undefined;
  }
  const schema = readExtensionSchema(extension);
  const key = new pkijs.AuthorityKeyIdentifier({ schema }).keyIdentifier;
  return key ? toHex(key.valueBlock.valueHexView) : undefined;
}

export function getCRLNumber(crl: pkijs.CertificateRevocationList): bigint | undefined {
  return getCRLInteger(crl, "2.5.29.20");
}

export function getDeltaBaseCRLNumber(crl: pkijs.CertificateRevocationList): bigint | undefined {
  return getCRLInteger(crl, "2.5.29.27");
}

function getCRLInteger(crl: pkijs.CertificateRevocationList, oid: string): bigint | undefined {
  const extension = crl.crlExtensions?.extensions.find((ext) => ext.extnID === oid);
  return extension ? readCRLInteger(extension) : undefined;
}

export function isDeltaCRL(crl: pkijs.CertificateRevocationList): boolean {
  return getDeltaBaseCRLNumber(crl) !== undefined;
}

/** AD CS Next CRL Publish: when the CA will publish its next CRL (before nextUpdate). */
export const NEXT_CRL_PUBLISH_OID = "1.3.6.1.4.1.311.21.4";

/**
 * The AD CS Next CRL Publish time; undefined without the extension. Its value must be exactly one
 * UTCTime / GeneralizedTime in the RFC 5280 form (AD CS writes a UTCTime): anything else throws.
 */
export function getNextCRLPublish(crl: pkijs.CertificateRevocationList): Date | undefined {
  const extension = crl.crlExtensions?.extensions.find(
    (ext) => ext.extnID === NEXT_CRL_PUBLISH_OID
  );
  return extension ? readStrictTime(readExtensionSchema(extension)).date : undefined;
}
