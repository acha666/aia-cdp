/**
 * Data conversion utilities: hex and hash
 */

// core has one SHA-256 implementation; it hashes exactly the bytes of the view.
export { sha256Hex } from "../digest.ts";

export const toHex = (input: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(input)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Bytes for WebCrypto, which takes `Uint8Array<ArrayBuffer>`: the same view (no copy) when it is
 * already backed by an ArrayBuffer, a copy of the view's bytes otherwise.
 */
export const toDigestInput = (input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> => {
  if (input instanceof Uint8Array) {
    return input.buffer instanceof ArrayBuffer
      ? (input as Uint8Array<ArrayBuffer>)
      : new Uint8Array(input);
  }
  return new Uint8Array(input);
};

export async function sha1Hex(data: ArrayBuffer | Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-1", toDigestInput(data));
  return toHex(digest);
}

export function decimalFromHex(hex: string | null) {
  if (!hex) {
    return null;
  }
  try {
    return BigInt(`0x${hex}`).toString(10);
  } catch {
    return null;
  }
}
