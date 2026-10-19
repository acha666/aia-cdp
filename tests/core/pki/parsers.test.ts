import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  getAuthorityKeyIdHex,
  getCN,
  getCommonName,
  getCRLNumber,
  getDeltaBaseCRLNumber,
  getSKIHex,
  isDeltaCRL,
  parseCertificate,
  parseCRL,
} from "../../../src/core/pki/parsers.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import { extension, pkiError } from "../../helpers/pki.ts";

// Parser parts of worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts:55, :75 and :149 (their
// builder and upload assertions move to slices 4 and 5a), plus what slice 2 changed: typed errors,
// offset views, non-string CNs and getAuthorityKeyIdHex(extensions).

function crlWith(ext: pkijs.Extension): pkijs.CertificateRevocationList {
  return new pkijs.CertificateRevocationList({
    crlExtensions: new pkijs.Extensions({ extensions: [ext] }),
  });
}

function certificate(name: string): pkijs.Certificate {
  const entry = manifest.certificates.find((c) => c.name === name);
  if (!entry) {
    throw new Error(`no manifest entry for ${name}`);
  }
  return parseCertificate(fixture(entry.der));
}

/** A Name with one single-attribute RDN per [type, value], in order. */
function nameOf(...rdns: [string, asn1.BaseBlock][]): pkijs.RelativeDistinguishedNames {
  const sequence = new asn1.Sequence({
    value: rdns.map(
      ([type, value]) =>
        new asn1.Set({
          value: [
            new asn1.Sequence({ value: [new asn1.ObjectIdentifier({ value: type }), value] }),
          ],
        })
    ),
  });
  return new pkijs.RelativeDistinguishedNames({
    schema: asn1.fromBER(sequence.toBER(false)).result,
  });
}

const CN = "2.5.4.3";
const O = "2.5.4.10";

/** CRL fixtures that parse (full-bad-time is the only invalid_crl one). */
const PARSABLE_CRLS = manifest.crls.filter((crl) => crl.expect !== "invalid_crl");

describe("parseCertificate / parseCRL", () => {
  it.each(manifest.certificates.map((c) => [c.name, c] as const))(
    "parses certs/%s.der with the declared validity",
    (_name, entry) => {
      const cert = parseCertificate(fixture(entry.der));
      expect(cert.notBefore.value).toEqual(new Date(entry.notBefore));
      expect(cert.notAfter.value).toEqual(new Date(entry.notAfter));
    }
  );

  it("rejects trailing bytes after the certificate or CRL", async () => {
    const der = fixture("certs/root-ca.der");
    expect(await pkiError(() => parseCertificate(Uint8Array.from([...der, 0])))).toEqual({
      kind: "certificate",
      reason: "trailing_bytes",
    });
    expect(await pkiError(() => parseCRL(fixture("invalid/trailing-byte.der")))).toEqual({
      kind: "crl",
      reason: "trailing_bytes",
    });
  });

  it("decodes exactly the bytes of an offset view", async () => {
    const der = fixture("certs/root-ca.der");
    const padded = new Uint8Array(der.length + 8).fill(0xff);
    padded.set(der, 4);
    const view = padded.subarray(4, 4 + der.length);
    // toSchema() without re-encoding reproduces the decoded DER.
    expect(new Uint8Array(parseCertificate(view).toSchema().toBER(false))).toEqual(der);
    expect(new Uint8Array(parseCertificate(der.buffer).toSchema().toBER(false))).toEqual(der);
    // One byte of the padding inside the view is a trailing byte; one byte short is not DER.
    expect(await pkiError(() => parseCertificate(padded.subarray(4, 5 + der.length)))).toEqual({
      kind: "certificate",
      reason: "trailing_bytes",
    });
    expect(await pkiError(() => parseCertificate(padded.subarray(4, 3 + der.length)))).toEqual({
      kind: "certificate",
      reason: "der",
    });
  });

  it.each(["invalid/garbage.txt", "invalid/empty.bin", "invalid/truncated.der"])(
    "rejects %s as undecodable DER",
    async (file) => {
      expect(await pkiError(() => parseCRL(fixture(file)))).toEqual({ kind: "crl", reason: "der" });
      expect(await pkiError(() => parseCertificate(fixture(file)))).toEqual({
        kind: "certificate",
        reason: "der",
      });
    }
  );

  it("rejects a decodable value of the wrong type as a structure error", async () => {
    expect(await pkiError(() => parseCRL(fixture("invalid/certificate.der")))).toEqual({
      kind: "crl",
      reason: "structure",
    });
    expect(
      await pkiError(() => parseCertificate(fixture("crls/issuing-ca-1/full-01.der")))
    ).toEqual({ kind: "certificate", reason: "structure" });
  });

  it("reports a malformed time as a time error", async () => {
    expect(await pkiError(() => parseCRL(fixture("crls/issuing-ca-1/full-bad-time.der")))).toEqual({
      kind: "crl",
      reason: "time",
    });
  });
});

describe("getCommonName", () => {
  it("returns the first CN in RDN order", () => {
    const name = nameOf(
      [O, new asn1.Utf8String({ value: "Example" })],
      [CN, new asn1.BmpString({ value: "First" })],
      [CN, new asn1.Utf8String({ value: "Second" })]
    );
    expect(getCommonName(name)).toBe("First");
  });

  it("returns undefined without a CN", () => {
    expect(getCommonName(nameOf([O, new asn1.Utf8String({ value: "Example" })]))).toBeUndefined();
  });

  it.each([
    ["INTEGER", new asn1.Integer({ value: 7 })],
    ["OCTET STRING", new asn1.OctetString({ valueHex: Uint8Array.of(0x41).buffer })],
    ["SEQUENCE", new asn1.Sequence({ value: [new asn1.Utf8String({ value: "nested" })] })],
  ])("returns undefined for a CN whose value is an %s", (_type, value) => {
    expect(getCommonName(nameOf([CN, value]))).toBeUndefined();
  });

  it("reads the subject CN of a certificate", () => {
    const cert = certificate("issuing-ca-1");
    // issuing-ca-1 issued leaf-full: its subject CN is leaf-full's issuer CN.
    expect(getCN(cert)).toBe(getCommonName(certificate("leaf-full").issuer));
    expect(getCN(cert)).toEqual(expect.any(String));
  });
});

describe("key identifiers", () => {
  it("reads the AKI keyIdentifier as lowercase hex (pki-values.test.ts:55)", () => {
    const aki = new pkijs.AuthorityKeyIdentifier({
      keyIdentifier: new asn1.OctetString({ valueHex: Uint8Array.of(0xab, 0xcd).buffer }),
      authorityCertIssuer: [new pkijs.GeneralName({ type: 6, value: "https://ca.example/issuer" })],
      authorityCertSerialNumber: new asn1.Integer({ value: 17 }),
    });
    const ext = extension("2.5.29.35", aki.toSchema());
    expect(getAuthorityKeyIdHex(crlWith(ext).crlExtensions?.extensions)).toBe("abcd");
    expect(getAuthorityKeyIdHex([ext])).toBe("abcd");
  });

  it("returns undefined without the extension or without a keyIdentifier", () => {
    expect(getAuthorityKeyIdHex(undefined)).toBeUndefined();
    expect(getAuthorityKeyIdHex([])).toBeUndefined();
    const issuerAndSerial = new pkijs.AuthorityKeyIdentifier({
      authorityCertIssuer: [new pkijs.GeneralName({ type: 6, value: "https://ca.example/issuer" })],
      authorityCertSerialNumber: new asn1.Integer({ value: 17 }),
    });
    expect(
      getAuthorityKeyIdHex([extension("2.5.29.35", issuerAndSerial.toSchema())])
    ).toBeUndefined();
    expect(getSKIHex(certificate("leaf-min"))).toBeUndefined();
    expect(getAuthorityKeyIdHex(certificate("leaf-min").extensions)).toBeUndefined();
  });

  it("throws on a malformed SKI or AKI", () => {
    expect(() => getAuthorityKeyIdHex([extension("2.5.29.35", new asn1.Null())])).toThrow();
    const cert = certificate("issuing-ca-1");
    cert.extensions = [extension("2.5.29.14", new asn1.Null())];
    expect(() => getSKIHex(cert)).toThrow();
  });

  it.each(PARSABLE_CRLS.map((crl) => [crl.file, crl] as const))(
    "%s: the CRL's AKI is the SKI of its issuer",
    (file, entry) => {
      const aki = getAuthorityKeyIdHex(parseCRL(fixture(file)).crlExtensions?.extensions);
      if (file === "crls/issuing-ca-1/full-no-aki.der") {
        expect(aki).toBeUndefined();
      } else {
        expect(aki).toMatch(/^(?:[0-9a-f]{2})+$/);
        expect(aki).toBe(getSKIHex(certificate(entry.issuer)));
      }
    }
  );
});

describe("CRL Number and Delta CRL Indicator", () => {
  it("preserve precision and reject negative or wrong-tag values (pki-values.test.ts:75)", () => {
    for (const [oid, read] of [
      ["2.5.29.20", getCRLNumber],
      ["2.5.29.27", getDeltaBaseCRLNumber],
    ] as const) {
      const large = 2n ** 100n + 123n;
      expect(read(crlWith(extension(oid, asn1.Integer.fromBigInt(large))))).toBe(large);
      for (const value of [
        new asn1.Integer({ value: -1 }),
        new asn1.Enumerated({ value: 1 }),
        new asn1.OctetString({ valueHex: Uint8Array.of(1).buffer }),
      ]) {
        expect(
          () => read(crlWith(extension(oid, value))),
          `${oid} ${value.constructor.name}`
        ).toThrow();
      }
    }
  });

  it.each(PARSABLE_CRLS.map((crl) => [crl.file, crl] as const))(
    "%s: number, base and kind match the manifest",
    (file, entry) => {
      const crl = parseCRL(fixture(file));
      expect(getCRLNumber(crl)?.toString() ?? null).toBe(entry.crlNumber);
      expect(getDeltaBaseCRLNumber(crl)?.toString() ?? null).toBe(entry.baseCrlNumber);
      expect(isDeltaCRL(crl)).toBe(entry.kind === "delta");
    }
  );
});

it("PKIjs runs on the WebCrypto engine it installs on import (no setEngine)", () => {
  expect(pkijs.getEngine().name).toBe("webcrypto");
});
