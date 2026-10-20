import { fromBER, OctetString } from "asn1js";
import * as pkijs from "pkijs";
import { Asn1TimeError, assertWellFormed, readStrictTime } from "./asn1.ts";
import { PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";
import { readCRLInteger, readExtensionSchema, readExtensionValue } from "./extensions.ts";
import { toHex } from "./conversion.ts";

const LABELS: Record<PkiKind, string> = { certificate: "certificate", crl: "CRL" };

// Strict DER (M1): one top-level element, no decoder errors, RFC 5280 times. A Uint8Array may be a
// view into a larger buffer: asn1js decodes the view, so the end offset is compared with its
// byteLength (the old callers passed `bytes.buffer` and decoded whatever surrounded the view).
function decodeDer(der: ArrayBuffer | Uint8Array, kind: PkiKind) {
  const label = LABELS[kind];
  const asn1 = fromBER(der);
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

/** Throws PkiParseError (kind "certificate", reason der / trailing_bytes / time / structure). */
export function parseCertificate(der: ArrayBuffer | Uint8Array): pkijs.Certificate {
  const schema = decodeDer(der, "certificate");
  return construct("certificate", () => new pkijs.Certificate({ schema }));
}

/** Throws PkiParseError (kind "crl", reason der / trailing_bytes / time / structure). */
export function parseCRL(der: ArrayBuffer | Uint8Array): pkijs.CertificateRevocationList {
  const schema = decodeDer(der, "crl");
  return construct("crl", () => new pkijs.CertificateRevocationList({ schema }));
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

export function getSKIHex(cert: pkijs.Certificate): string | undefined {
  const extension = cert.extensions?.find((ext) => ext.extnID === "2.5.29.14");
  if (!extension) {
    return undefined;
  }
  return toHex(readExtensionValue(extension, OctetString).valueBlock.valueHexView);
}

/**
 * keyIdentifier of the Authority Key Identifier in `extensions` (`cert.extensions` or
 * `crl.crlExtensions?.extensions`), lowercase hex; undefined without the extension or without a
 * keyIdentifier. Throws when the extension is present but malformed.
 */
export function getAuthorityKeyIdHex(
  extensions: pkijs.Extension[] | undefined
): string | undefined {
  const extension = extensions?.find((ext) => ext.extnID === "2.5.29.35");
  if (!extension) {
    return undefined;
  }
  const key = readExtensionValue(extension, pkijs.AuthorityKeyIdentifier).keyIdentifier;
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
