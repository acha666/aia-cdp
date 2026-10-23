// Shared by the PKI, import, publish and CRL detail tests.
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { PkiParseError } from "../../src/core/pki/errors.ts";
import type { PkiKind, PkiParseReason } from "../../src/core/pki/errors.ts";

/**
 * `{ kind, reason }` of the PkiParseError that `run` throws or rejects with, so a test compares
 * both at once. Anything else (another error, no error) fails the test.
 */
export async function pkiError(
  run: () => unknown
): Promise<{ kind: PkiKind; reason: PkiParseReason }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PkiParseError) {
      return { kind: error.kind, reason: error.reason };
    }
    throw error;
  }
  throw new Error("Expected a PkiParseError, but nothing was thrown");
}

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

/** An X.509 extension whose extnValue is the DER of `value` (an asn1js block or PKIjs schema). */
export function extension(
  oid: string,
  value: { toBER(sizeOnly?: boolean): ArrayBuffer },
  critical = false
): pkijs.Extension {
  return new pkijs.Extension({ extnID: oid, critical, extnValue: value.toBER(false) });
}

/** The definite-form length octets of `length` (X.690 §8.1.3, the fewest octets). */
function lengthOctets(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest & 0xff);
  }
  return [0x80 | octets.length, ...octets];
}

/** A TLV of `tag` around `contents`. */
function tlv(tag: number, contents: ArrayLike<number>): Uint8Array {
  return Uint8Array.from([tag, ...lengthOctets(contents.length), ...Array.from(contents)]);
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
  return tlv(0x30, [
    ...tbs.valueBeforeDecodeView,
    ...rewrite(algorithm.valueBeforeDecodeView),
    ...signature.valueBeforeDecodeView,
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
  return tlv(0x30, [...tlv(0x06, padded), ...parameters]);
}

/**
 * The AlgorithmIdentifier `algorithm` with NULL parameters holding one octet (X.690 §8.8.2 forbids
 * contents), in place of its NULL or absent parameters; asn1js decodes it as NULL.
 */
export function nullWithContents(algorithm: Uint8Array): Uint8Array {
  const [oid] = algorithmParts(algorithm);
  return tlv(0x30, [...tlv(0x06, oid), 0x05, 0x01, 0x00]);
}
