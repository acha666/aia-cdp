// Shared by the PKI, import, publish and CRL detail tests.
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { expect } from "vitest";
import type { PkiKind, PkiParseReason } from "../../src/core/pki/errors.ts";
import { encodeTlv } from "../../src/core/pki/pem.ts";

/** Matches a PkiParseError of `kind` and `reason`, for toThrow and rejects.toThrow. */
export const pkiError = (kind: PkiKind, reason: PkiParseReason): unknown =>
  expect.objectContaining({ name: "PkiParseError", kind, reason });

/**
 * BER encodings of one DER TLV (a certificate or CRL fixture) that DER forbids, each with the same
 * content octets and so, without the check, the same certificate under another SHA-256 id.
 */
export function berVariants(der: Uint8Array): [variant: string, bytes: Uint8Array][] {
  const tag = der[0] ?? 0;
  const first = der[1] ?? 0;
  const content = der.subarray(first < 0x80 ? 2 : 2 + (first & 0x7f));
  const length = content.byteLength;
  const fourOctets = [length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  return [
    [
      "a length in more octets than needed",
      Uint8Array.from([tag, 0x84, ...fourOctets, ...content]),
    ],
    ["the indefinite length", Uint8Array.from([tag, 0x80, ...content, 0, 0])],
    // The class and constructed bits stay; the tag number moves to a subsequent octet.
    [
      "the high-tag-number form",
      Uint8Array.from([(tag & 0xe0) | 0x1f, tag & 0x1f, ...der.subarray(1)]),
    ],
  ];
}

/** An AttributeTypeAndValue of `type` as an asn1js block; `value` need not be a string type. */
export function attribute(type: string, value: asn1.BaseBlock): asn1.Sequence {
  return new pkijs.AttributeTypeAndValue({
    type,
    // PKIjs typing only covers string values.
    value: value as unknown as pkijs.AttributeTypeAndValue["value"],
  }).toSchema();
}

/** A Name with one RDN per argument (a SET of its attributes, in order), decoded by PKIjs. */
export function nameOf(...rdns: asn1.Sequence[][]): pkijs.RelativeDistinguishedNames {
  const sequence = new asn1.Sequence({ value: rdns.map((value) => new asn1.Set({ value })) });
  return new pkijs.RelativeDistinguishedNames({
    schema: asn1.fromBER(sequence.toBER(false)).result,
  });
}

/** An X.509 extension whose extnValue is the DER of `value` (an asn1js block or PKIjs schema). */
export function extension(
  oid: string,
  value: { toBER(sizeOnly?: boolean): ArrayBuffer },
  critical = false
): pkijs.Extension {
  return new pkijs.Extension({ extnID: oid, critical, extnValue: value.toBER(false) });
}

/**
 * `der` (a certificate or CRL: SEQUENCE { tbs, signatureAlgorithm, signatureValue }) with its outer
 * signatureAlgorithm replaced by `rewrite` of its octets. That field is outside the signature, so
 * anyone holding the file can do this.
 */
export function withOuterAlgorithm(
  der: Uint8Array,
  rewrite: (algorithm: Uint8Array) => Uint8Array
): Uint8Array {
  const [tbs, algorithm, signature] = (asn1.fromBER(der).result as asn1.Sequence).valueBlock.value;
  if (tbs === undefined || algorithm === undefined || signature === undefined) {
    throw new Error("not SEQUENCE { tbs, signatureAlgorithm, signatureValue }");
  }
  return encodeTlv(0x30, [
    tbs.valueBeforeDecodeView,
    rewrite(algorithm.valueBeforeDecodeView),
    signature.valueBeforeDecodeView,
  ]);
}

/** OID and parameter octets of an AlgorithmIdentifier with one-octet lengths, as the fixtures have. */
function algorithmParts(algorithm: Uint8Array): [oid: Uint8Array, parameters: Uint8Array] {
  if (algorithm[0] !== 0x30 || algorithm[2] !== 0x06 || (algorithm[3] ?? 0x80) >= 0x80) {
    throw new Error("unexpected AlgorithmIdentifier layout");
  }
  const end = 4 + (algorithm[3] ?? 0);
  return [algorithm.subarray(4, end), algorithm.subarray(end)];
}

/**
 * The AlgorithmIdentifier `algorithm` with the last subidentifier of its OID led by a redundant
 * 0x80, which X.690 §8.19.2 forbids; asn1js decodes it as the same OID.
 */
export function padOid(algorithm: Uint8Array): Uint8Array {
  const [oid, parameters] = algorithmParts(algorithm);
  // The last subidentifier starts after the last octet before it with bit 8 clear.
  let start = oid.length - 1;
  while (start > 0 && ((oid[start - 1] ?? 0) & 0x80) !== 0) {
    start--;
  }
  const padded = [...oid.subarray(0, start), 0x80, ...oid.subarray(start)];
  return encodeTlv(0x30, [encodeTlv(0x06, [Uint8Array.from(padded)]), parameters]);
}

/**
 * The AlgorithmIdentifier `algorithm` with NULL parameters holding one octet (X.690 §8.8.2 forbids
 * contents), in place of its NULL or absent parameters; asn1js decodes it as NULL.
 */
export function nullWithContents(algorithm: Uint8Array): Uint8Array {
  const [oid] = algorithmParts(algorithm);
  return encodeTlv(0x30, [encodeTlv(0x06, [oid]), Uint8Array.of(0x05, 0x01, 0x00)]);
}
