import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import {
  derToPem,
  extractPEMBlock,
  PEM_BLOCK_MARKERS,
  pemLength,
  splitPemBlocks,
  toDer,
} from "../../../src/core/pki/pem.ts";
import { fixture, fixturePath } from "../../fixtures/pki.ts";
import { pkiError } from "../../helpers/pki.ts";

// worker-aia-cdp@5b570aa:tests/worker/pem.test.ts as is, plus toDer and splitPemBlocks (M7) and the
// download format: pemLength and derToPem against OpenSSL's output (M22, slice 3 step 1).

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

const encode = (value: string) => new TextEncoder().encode(value);

const ROOT_DER = fixture("certs/root-ca.der");
const ROOT_PEM = text("certs/root-ca.pem");

it("PEM encoding handles large CRLs and sliced buffers without truncation", () => {
  const buffer = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, index) => index % 256);
  const bytes = buffer.subarray(3, buffer.length - 2);
  const { begin, end } = PEM_BLOCK_MARKERS.crl;
  const pem = derToPem(bytes, begin, end);
  // Buffer.compare instead of toEqual: a deep equality walk over 1 MiB takes seconds on CI runners.
  expect(Buffer.compare(extractPEMBlock(pem, begin, end), bytes)).toBe(0);
  const lines = pem.trim().split("\n");
  expect(lines[0]).toBe(begin);
  expect(lines.at(-1)).toBe(end);
  expect(lines.slice(1, -1).every((line) => line.length <= 64)).toBe(true);
});

describe("toDer", () => {
  it("returns DER unchanged", () => {
    expect(toDer(ROOT_DER, "certificate")).toBe(ROOT_DER);
    const crl = fixture("crls/issuing-ca-1/full-01.der");
    expect(toDer(crl, "crl")).toBe(crl);
  });

  it("decodes PEM", () => {
    expect(toDer(encode(ROOT_PEM), "certificate")).toEqual(ROOT_DER);
    expect(toDer(fixture("crls/root-ca/full-01.pem"), "crl")).toEqual(
      fixture("crls/root-ca/full-01.der")
    );
  });

  it("tolerates a UTF-8 BOM and explanatory text around the block", () => {
    const input = encode(`\uFEFFBag Attributes\n    subject=Zürich\n${ROOT_PEM}\ntrailing notes\n`);
    expect(input.subarray(0, 3)).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf));
    expect(toDer(input, "certificate")).toEqual(ROOT_DER);
  });

  it("decodes CRLF line endings", () => {
    const crlf = fixture("crls/issuing-ca-1/full-01.crlf.pem");
    expect(new TextDecoder().decode(crlf)).toContain("\r\n");
    expect(toDer(crlf, "crl")).toEqual(fixture("crls/issuing-ca-1/full-01.der"));
  });

  it("recognizes DER by its outer length, not by a leading 0x30", () => {
    // "0" is 0x30: text that starts with it is still PEM.
    const input = encode(`0 is how this note starts\n${ROOT_PEM}`);
    expect(input[0]).toBe(0x30);
    expect(toDer(input, "certificate")).toEqual(ROOT_DER);
  });

  it("passes input that is neither DER nor PEM to the strict parser unchanged", async () => {
    const trailing = fixture("invalid/trailing-byte.der");
    expect(toDer(trailing, "crl")).toBe(trailing);
    expect(await pkiError(() => parseCRL(toDer(trailing, "crl")))).toEqual({
      kind: "crl",
      reason: "trailing_bytes",
    });
    for (const file of ["invalid/garbage.txt", "invalid/empty.bin", "invalid/truncated.der"]) {
      const bytes = fixture(file);
      expect(toDer(bytes, "crl"), file).toBe(bytes);
      expect(await pkiError(() => parseCRL(toDer(bytes, "crl")))).toEqual({
        kind: "crl",
        reason: "der",
      });
    }
  });

  it("rejects a block labelled for the other kind", async () => {
    expect(await pkiError(() => toDer(encode(ROOT_PEM), "crl"))).toEqual({
      kind: "crl",
      reason: "pem_label",
    });
    expect(await pkiError(() => toDer(fixture("crls/root-ca/full-01.pem"), "certificate"))).toEqual(
      { kind: "certificate", reason: "pem_label" }
    );
    const key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    expect(await pkiError(() => toDer(encode(`${ROOT_PEM}${key}`), "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_label",
    });
  });

  it("rejects two blocks instead of using the first", async () => {
    const bundle = encode(`${ROOT_PEM}${text("certs/issuing-ca-1.pem")}`);
    expect(await pkiError(() => toDer(bundle, "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
  });

  it("rejects a block without its END line", async () => {
    expect(await pkiError(() => toDer(fixture("invalid/truncated.pem"), "crl"))).toEqual({
      kind: "crl",
      reason: "pem_blocks",
    });
    const noEnd = ROOT_PEM.replace(PEM_BLOCK_MARKERS.certificate.end, "");
    expect(await pkiError(() => toDer(encode(noEnd), "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
  });

  it("rejects a body that is not base64", async () => {
    const lines = ROOT_PEM.split("\n");
    const body = lines[1] ?? "";
    const variants = {
      character: body.replace(/^./, "*"),
      length: body.slice(1),
      padding: `${body.slice(0, 2)}==${body.slice(4)}`,
    };
    for (const [variant, line] of Object.entries(variants)) {
      const pem = [lines[0], line, ...lines.slice(2)].join("\n");
      expect(await pkiError(() => toDer(encode(pem), "certificate")), variant).toEqual({
        kind: "certificate",
        reason: "pem_base64",
      });
    }
  });

  // A regexp with a repeated group overflowed V8's regexp stack from about 5 MiB of base64, which
  // a raised AIA_MAX_UPLOAD_BYTES lets through (a 500 instead of a 422).
  it("checks a base64 body of several MiB", () => {
    const size = 6 * 1024 * 1024;
    const lines = Array.from({ length: size / 64 }, () => "A".repeat(64)).join("\n");
    const pem = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
    const der = toDer(encode(pem), "certificate");
    expect(der.byteLength).toBe((size / 4) * 3);
    expect(der.every((byte) => byte === 0)).toBe(true);
  });
});

describe("splitPemBlocks", () => {
  const names = ["root-ca", "issuing-ca-1", "issuing-ca-2"];

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
      names.map((name) => fixture(`certs/${name}.der`))
    );
    expect(blocks.every((block) => block.endsWith("-----\n"))).toBe(true);
    expect(blocks.some((block) => block.includes("PRIVATE KEY"))).toBe(false);
    const crls = splitPemBlocks(bundle, "crl");
    expect(crls.map((block) => toDer(encode(block), "crl"))).toEqual([
      fixture("crls/root-ca/full-01.der"),
    ]);
  });

  it("returns a single block unchanged and nothing for text without blocks", () => {
    expect(splitPemBlocks(ROOT_PEM, "certificate")).toEqual([ROOT_PEM]);
    expect(splitPemBlocks("no PEM here\n", "certificate")).toEqual([]);
    expect(splitPemBlocks(ROOT_PEM, "crl")).toEqual([]);
  });

  it("rejects a truncated bundle instead of importing part of it", async () => {
    const truncated = `${ROOT_PEM}${text("certs/issuing-ca-1.pem").replace("-----END", "")}`;
    expect(await pkiError(() => splitPemBlocks(truncated, "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
    expect(await pkiError(() => splitPemBlocks(text("invalid/truncated.pem"), "crl"))).toEqual({
      kind: "crl",
      reason: "pem_blocks",
    });
    const strayEnd = `${PEM_BLOCK_MARKERS.certificate.end}\n${ROOT_PEM}`;
    expect(await pkiError(() => splitPemBlocks(strayEnd, "certificate"))).toEqual({
      kind: "certificate",
      reason: "pem_blocks",
    });
  });
});

describe("the download PEM format (M22)", () => {
  it("pemLength equals the length of derToPem's output", () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 7) % 256);
    const sizes = [...Array.from({ length: 4096 }, (_, index) => index + 1), bytes.length];
    // Collected rather than asserted one by one: 8194 cases.
    const mismatches: string[] = [];
    for (const [kind, markers] of Object.entries(PEM_BLOCK_MARKERS)) {
      for (const size of sizes) {
        const pem = derToPem(bytes.subarray(0, size), markers.begin, markers.end);
        if (pemLength(size, markers) !== pem.length) {
          mismatches.push(`${kind} ${size}: ${pemLength(size, markers)} ≠ ${pem.length}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("derToPem reproduces OpenSSL's PEM byte for byte", () => {
    const cases = [
      ["certs/root-ca", PEM_BLOCK_MARKERS.certificate],
      ["crls/issuing-ca-1/full-01", PEM_BLOCK_MARKERS.crl],
    ] as const;
    for (const [name, { begin, end }] of cases) {
      const der = fixture(`${name}.der`);
      const pem = encode(derToPem(der, begin, end));
      expect(pem, name).toEqual(fixture(`${name}.pem`));
      expect(pem.byteLength, name).toBe(pemLength(der.byteLength, { begin, end }));
    }
  });
});
