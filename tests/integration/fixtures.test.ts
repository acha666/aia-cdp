import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, NOW, fixture, fixturePath, manifest } from "../fixtures/pki.ts";

// Self-test of tests/fixtures/generate-test-data.sh and of the tree that globalSetup generated
// (implementation slice 1 step 9, appendix D).

const GENERATOR = fileURLToPath(new URL("../fixtures/generate-test-data.sh", import.meta.url));
const OPENSSL = process.env.OPENSSL ?? "openssl";

function generator(...args: string[]) {
  return spawnSync("bash", [GENERATOR, ...args, FIXTURES_DIR], { encoding: "utf8" });
}

function openssl(...args: string[]): string {
  return execFileSync(OPENSSL, args, { encoding: "utf8" });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crl(file: string) {
  const entry = manifest.crls.find((c) => c.file === file);
  if (!entry) {
    throw new Error(`no manifest entry for ${file}`);
  }
  return entry;
}

describe("generated PKI fixtures", () => {
  it("--check reports the tree as up to date", () => {
    const run = generator("--check");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^up to date: /);
  });

  it("a second run is a no-op and leaves .stamp untouched", () => {
    const stamp = fixturePath(".stamp");
    const before = { text: readFileSync(stamp, "utf8"), mtimeMs: statSync(stamp).mtimeMs };
    const run = generator();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^up to date: /);
    expect({ text: readFileSync(stamp, "utf8"), mtimeMs: statSync(stamp).mtimeMs }).toEqual(before);
    expect(before.text.trim()).toBe(manifest.generatorSha256);
  });

  it("has the appendix D inventory", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.certificates).toHaveLength(12);
    expect(manifest.crls).toHaveLength(30);
    expect(manifest.invalid).toHaveLength(6);
    expect(manifest.scenarios).toHaveLength(17);
  });

  it("records the sha256 of every certificate and CRL", () => {
    for (const cert of manifest.certificates) {
      expect(sha256(fixture(cert.der)), cert.der).toBe(cert.sha256);
    }
    for (const entry of manifest.crls) {
      expect(sha256(fixture(entry.file)), entry.file).toBe(entry.sha256);
    }
  });

  it("injects the fixed clock", () => {
    expect(manifest.now).toBe("2026-01-04T00:00:00Z");
    expect(NOW.toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });

  it("declares the appendix D values", () => {
    expect(crl("crls/issuing-ca-1/full-02.der")).toMatchObject({
      kind: "full",
      crlNumber: "3",
      baseCrlNumber: null,
      thisUpdate: "2026-01-02T00:00:00Z",
      nextUpdate: "2026-01-09T00:00:00Z",
      revoked: 1,
      expect: "created",
    });
    expect(crl("crls/issuing-ca-1/delta-01.der")).toMatchObject({
      kind: "delta",
      crlNumber: "2",
      baseCrlNumber: "1",
    });
    expect(crl("crls/issuing-ca-1/full-no-number.der").crlNumber).toBeNull();
    expect(crl("crls/issuing-ca-1/full-no-next-update.der").nextUpdate).toBeNull();
    expect(crl("crls/issuing-ca-1/full-forged-aki.der")).toMatchObject({
      issuer: "issuing-ca-1",
      signer: "rogue-ca",
      expect: "invalid_signature",
    });
    expect(manifest.certificates.find((c) => c.name === "leaf-min")).toMatchObject({
      issuer: "issuing-ca-1",
      serial: "2001",
      import: false,
    });
  });

  it("declares what the files contain", () => {
    const out = openssl(
      "crl",
      "-inform",
      "DER",
      "-noout",
      "-crlnumber",
      "-lastupdate",
      "-in",
      fixturePath("crls/issuing-ca-1/full-02.der")
    );
    const number = /crlNumber=(0x[0-9A-Fa-f]+)/.exec(out)?.[1];
    expect(number && BigInt(number).toString()).toBe(
      crl("crls/issuing-ca-1/full-02.der").crlNumber
    );
    expect(out).toMatch(/lastUpdate=Jan {2}2 00:00:00 2026 GMT/);
  });

  it("contains no private key material", () => {
    const files = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" }).filter((f) =>
      statSync(fixturePath(f)).isFile()
    );
    expect(files.length).toBeGreaterThan(60);
    const leaking = files.filter((f) => readFileSync(fixturePath(f)).includes("PRIVATE KEY"));
    expect(leaking).toEqual([]);
  });

  it("certs/leaf-min has no subject or authority key identifier", () => {
    const text = (path: string) =>
      openssl("x509", "-inform", "DER", "-noout", "-text", "-in", fixturePath(path));
    expect(text("certs/leaf-min.der")).not.toContain("Key Identifier");
    // Control: the same probe sees both identifiers on a leaf that has them.
    expect(text("certs/leaf-full.der")).toContain("Subject Key Identifier");
    expect(text("certs/leaf-full.der")).toContain("Authority Key Identifier");
  });
});
