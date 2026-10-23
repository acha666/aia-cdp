import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derToPem, pemLength, splitPemBlocks, toDer } from "../../../src/core/pki/pem.ts";
import { fixture, fixturePath } from "../../fixtures/pki.ts";
import { pkiError } from "../../helpers/pki.ts";

// Upload input (toDer, splitPemBlocks) and the download format (derToPem, pemLength) against
// OpenSSL's output.

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

const encode = (value: string) => new TextEncoder().encode(value);

const ROOT_DER = fixture("certs/root-ca.der");
const ROOT_PEM = text("certs/root-ca.pem");
const CRL_DER = fixture("crls/issuing-ca-1/full-01.der");

describe("toDer", () => {
  it("returns DER unchanged, and input that is neither DER nor PEM too", () => {
    expect(toDer(CRL_DER, "crl")).toBe(CRL_DER);
    const garbage = fixture("invalid/garbage.txt");
    expect(toDer(garbage, "crl")).toBe(garbage);
  });

  it("decodes PEM with CRLF, a UTF-8 BOM or explanatory text around the block", () => {
    expect(toDer(encode(ROOT_PEM), "certificate")).toEqual(ROOT_DER);
    expect(toDer(fixture("crls/issuing-ca-1/full-01.crlf.pem"), "crl")).toEqual(CRL_DER);
    const wrapped = `\uFEFFBag Attributes\n    subject=Zürich\n${ROOT_PEM}\ntrailing notes\n`;
    expect(toDer(encode(wrapped), "certificate")).toEqual(ROOT_DER);
    // "0" is 0x30: DER is recognized by its outer length, not by a leading 0x30.
    expect(toDer(encode(`0 is how this note starts\n${ROOT_PEM}`), "certificate")).toEqual(
      ROOT_DER
    );
  });

  it("rejects a block labelled for the other kind", async () => {
    expect(await pkiError(() => toDer(encode(ROOT_PEM), "crl"))).toEqual({
      kind: "crl",
      reason: "pem_label",
    });
  });

  it("rejects two blocks instead of using the first, and a block without its END line", async () => {
    const bundle = encode(`${ROOT_PEM}${text("certs/issuing-ca-1.pem")}`);
    expect(await pkiError(() => toDer(bundle, "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
    expect(await pkiError(() => toDer(fixture("invalid/truncated.pem"), "crl"))).toEqual({
      kind: "crl",
      reason: "pem_blocks",
    });
  });

  it("rejects a body that is not base64", async () => {
    const lines = ROOT_PEM.split("\n");
    const pem = [lines[0], (lines[1] ?? "").replace(/^./, "*"), ...lines.slice(2)].join("\n");
    expect(await pkiError(() => toDer(encode(pem), "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_base64",
    });
  });

  // A regexp with a repeated group overflowed V8's regexp stack from about 5 MiB of base64, which
  // a raised AIA_MAX_UPLOAD_BYTES lets through.
  it("round-trips 6 MiB from a sliced buffer through derToPem", () => {
    const buffer = Uint8Array.from({ length: 6 * 1024 * 1024 + 7 }, (_, index) => index % 256);
    const bytes = buffer.subarray(3, buffer.length - 2);
    const pem = derToPem(bytes, "crl");
    // Buffer.compare instead of toEqual: a deep equality walk over MiBs takes seconds.
    expect(Buffer.compare(toDer(encode(pem), "crl"), bytes)).toBe(0);
  });
});

describe("splitPemBlocks", () => {
  it("returns every complete block of the kind, in order, and skips other labels", () => {
    const bundle = [
      "chain exported for the AIA service\r\n",
      text("certs/root-ca.pem"),
      text("crls/root-ca/full-01.pem"),
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      text("certs/issuing-ca-1.pem").replaceAll("\n", "\r\n"),
      text("certs/issuing-ca-2.pem"),
    ].join("");
    const blocks = splitPemBlocks(bundle, "certificate");
    expect(blocks.map((block) => toDer(encode(block), "certificate"))).toEqual(
      ["root-ca", "issuing-ca-1", "issuing-ca-2"].map((name) => fixture(`certs/${name}.der`))
    );
    expect(splitPemBlocks(bundle, "crl").map((block) => toDer(encode(block), "crl"))).toEqual([
      fixture("crls/root-ca/full-01.der"),
    ]);
  });

  it("rejects a truncated bundle instead of importing part of it", async () => {
    const truncated = `${ROOT_PEM}${text("certs/issuing-ca-1.pem").replace("-----END", "")}`;
    expect(await pkiError(() => splitPemBlocks(truncated, "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
  });
});

describe("the download PEM format", () => {
  it("derToPem reproduces OpenSSL's PEM byte for byte", () => {
    for (const [name, kind] of [
      ["certs/root-ca", "certificate"],
      ["crls/issuing-ca-1/full-01", "crl"],
    ] as const) {
      const pem = encode(derToPem(fixture(`${name}.der`), kind));
      expect(pem, name).toEqual(fixture(`${name}.pem`));
    }
  });

  // A PEM HEAD takes its Content-Length from pemLength.
  it("pemLength equals the length of derToPem's output", () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 7) % 256);
    const sizes = [...Array.from({ length: 4096 }, (_, index) => index + 1), bytes.length];
    // Collected rather than asserted one by one: 8194 cases.
    const mismatches: string[] = [];
    for (const kind of ["certificate", "crl"] as const) {
      for (const size of sizes) {
        const pem = derToPem(bytes.subarray(0, size), kind);
        if (pemLength(size, kind) !== pem.length) {
          mismatches.push(`${kind} ${size}: ${pemLength(size, kind)} ≠ ${pem.length}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
