// Hex and WebCrypto digests (Workers and Node 26; the web program only type-checks them). No
// imports: storage and the CLI use them without loading asn1js or PKIjs.

/** Lowercase hex of `input`: of a view, exactly its bytes. */
export const toHex = (input: ArrayBuffer | Uint8Array) =>
  (input instanceof Uint8Array ? input : new Uint8Array(input)).toHex();

/**
 * Bytes for WebCrypto. TypeScript's DOM lib (the web program reaches core through hc<AppType>)
 * types its input as ArrayBufferView<ArrayBuffer>, so a Uint8Array<ArrayBufferLike> is rejected
 * there. A view backed by an ArrayBuffer is passed as is and an ArrayBuffer is wrapped; only a view
 * of another buffer is copied.
 */
export const toDigestInput = (input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> =>
  input instanceof Uint8Array && input.buffer instanceof ArrayBuffer
    ? (input as Uint8Array<ArrayBuffer>)
    : new Uint8Array(input);

async function digestHex(algorithm: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest(algorithm, toDigestInput(data)));
}

/** Lowercase hex SHA-256 of `data`: of a view, exactly its bytes (not its whole buffer). */
export function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return digestHex("SHA-256", data);
}

/** Lowercase hex SHA-1 of `data`: of a view, exactly its bytes (not its whole buffer). */
export function sha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return digestHex("SHA-1", data);
}
