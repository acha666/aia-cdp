/**
 * Lowercase hex SHA-256 via WebCrypto (Workers, Node 24 and browsers).
 *
 * `bytes` may be any Uint8Array. TypeScript's DOM lib (the web program reaches core through
 * hc<AppType>) types WebCrypto's input as ArrayBufferView<ArrayBuffer>, so a
 * Uint8Array<ArrayBufferLike> is rejected there. Narrow without copying when the view is already
 * backed by an ArrayBuffer.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
