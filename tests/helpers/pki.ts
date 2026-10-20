// Shared by the PKI core tests (and the import / publish tests of slices 2 and 4).
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

// The Subject Key Identifier extension up to its keyIdentifier: extnID 2.5.29.14, extnValue
// OCTET STRING (22) { OCTET STRING (20) }.
const SKI_PREFIX = [0x06, 0x03, 0x55, 0x1d, 0x0e, 0x04, 0x16, 0x04, 0x14];

/**
 * `der` with the first octets of its 20-octet SKI keyIdentifier overwritten in place (no length
 * changes; the signature no longer matches, which import does not check).
 */
export function withSkiPrefix(der: Uint8Array, prefix: number[]): Uint8Array {
  const at = der.findIndex((_, index) => SKI_PREFIX.every((byte, k) => der[index + k] === byte));
  if (at < 0) {
    throw new Error("no 20-octet Subject Key Identifier");
  }
  const patched = der.slice();
  patched.set(prefix, at + SKI_PREFIX.length);
  return patched;
}

/**
 * `der` (a certificate with a two-octet outer and TBS length, as every fixture CA has) with its
 * serialNumber INTEGER emptied: `02 00`, which X.690 §8.3.1 forbids and asn1js decodes without an
 * error.
 */
export function withEmptySerial(der: Uint8Array): Uint8Array {
  // 30 82 LL LL | 30 82 LL LL | a0 03 02 01 02 (version) | 02 <n> <serial>
  const layout = [0x30, 0x82, -1, -1, 0x30, 0x82, -1, -1, 0xa0, 0x03, 0x02, 0x01, 0x02, 0x02];
  if (!layout.every((byte, index) => byte < 0 || der[index] === byte)) {
    throw new Error("unexpected certificate layout");
  }
  const serialLength = der[14] ?? 0;
  const out = Uint8Array.from([...der.subarray(0, 15), ...der.subarray(15 + serialLength)]);
  out[14] = 0;
  for (const at of [2, 6]) {
    const length = (((der[at] ?? 0) << 8) | (der[at + 1] ?? 0)) - serialLength;
    if (length < 256) {
      throw new Error("the lengths would no longer need two octets");
    }
    out[at] = length >> 8;
    out[at + 1] = length & 0xff;
  }
  return out;
}

/** An X.509 extension whose extnValue is the DER of `value` (an asn1js block or PKIjs schema). */
export function extension(
  oid: string,
  value: { toBER(sizeOnly?: boolean): ArrayBuffer }
): pkijs.Extension {
  return new pkijs.Extension({ extnID: oid, extnValue: value.toBER(false) });
}
