import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  getAuthorityKeyIdHex,
  getCommonName,
  getCRLInteger,
  parseCertificate,
  parseCRL,
} from "../../../src/core/pki/parsers.ts";
import { fixture } from "../../fixtures/pki.ts";
import { attribute, berVariants, extension, nameOf } from "../../helpers/pki.ts";

const ROOT = "certs/root-ca.der";

describe("parseCertificate / parseCRL", () => {
  it("rejects undecodable DER, trailing bytes and a value of the wrong type", () => {
    for (const [kind, parse] of [
      ["certificate", parseCertificate],
      ["crl", parseCRL],
    ] as const) {
      expect(() => parse(fixture("invalid/truncated.der"))).toThrow(
        expect.objectContaining({ name: "PkiParseError", kind, reason: "der" })
      );
      const der = fixture(kind === "crl" ? "crls/root-ca/full-01.der" : ROOT);
      expect(() => parse(Uint8Array.from([...der, 0]))).toThrow(
        expect.objectContaining({ name: "PkiParseError", kind, reason: "trailing_bytes" })
      );
    }
    expect(() => parseCRL(fixture("invalid/certificate.der"))).toThrow(
      expect.objectContaining({ name: "PkiParseError", kind: "crl", reason: "structure" })
    );
  });

  // Node's Buffer pool hands out views into a larger buffer.
  it("decodes exactly the bytes of an offset view", () => {
    const der = fixture(ROOT);
    const padded = new Uint8Array(der.length + 8).fill(0xff);
    padded.set(der, 4);
    const view = padded.subarray(4, 4 + der.length);
    expect(new Uint8Array(parseCertificate(view).toSchema().toBER(false))).toEqual(der);
    expect(() => parseCertificate(padded.subarray(4, 5 + der.length))).toThrow(
      expect.objectContaining({
        name: "PkiParseError",
        kind: "certificate",
        reason: "trailing_bytes",
      })
    );
  });

  // A BER re-encoding of the unsigned outer SEQUENCE leaves the TBS and the signature intact: one
  // CA under several ids, one CRL under several digests.
  it("rejects BER encodings of the outer SEQUENCE as a DER error", () => {
    for (const [kind, file, parse] of [
      ["certificate", "certs/issuing-ca-1.der", parseCertificate],
      ["crl", "crls/issuing-ca-1/full-01.der", parseCRL],
    ] as const) {
      for (const [variant, bytes] of berVariants(fixture(file))) {
        expect(() => parse(bytes), `${kind}: ${variant}`).toThrow(
          expect.objectContaining({ name: "PkiParseError", kind, reason: "der" })
        );
      }
    }
  });
});

describe("names and key identifiers", () => {
  it("takes the first CN in RDN order, and none whose value is not a string", () => {
    const name = nameOf(
      [attribute("2.5.4.10", new asn1.Utf8String({ value: "Example" }))],
      [attribute("2.5.4.3", new asn1.BmpString({ value: "First" }))],
      [attribute("2.5.4.3", new asn1.Utf8String({ value: "Second" }))]
    );
    expect(getCommonName(name)).toBe("First");
    const integer = nameOf([attribute("2.5.4.3", new asn1.Integer({ value: 7 }))]);
    expect(getCommonName(integer)).toBeUndefined();
    const withoutCn = nameOf([attribute("2.5.4.10", new asn1.Utf8String({ value: "Example" }))]);
    expect(getCommonName(withoutCn)).toBeUndefined();
  });

  it("reads the AKI keyIdentifier as lowercase hex, undefined without one, and throws on a malformed one", () => {
    const issuer = [new pkijs.GeneralName({ type: 6, value: "https://ca.example/issuer" })];
    const serial = new asn1.Integer({ value: 17 });
    const aki = (keyIdentifier?: asn1.OctetString) =>
      extension(
        "2.5.29.35",
        new pkijs.AuthorityKeyIdentifier({
          ...(keyIdentifier === undefined ? {} : { keyIdentifier }),
          authorityCertIssuer: issuer,
          authorityCertSerialNumber: serial,
        }).toSchema()
      );
    const keyId = new asn1.OctetString({ valueHex: Uint8Array.of(0xab, 0xcd).buffer });
    expect(getAuthorityKeyIdHex([aki(keyId)])).toBe("abcd");
    expect(getAuthorityKeyIdHex([aki()])).toBeUndefined();
    expect(getAuthorityKeyIdHex(undefined)).toBeUndefined();
    expect(() => getAuthorityKeyIdHex([extension("2.5.29.35", new asn1.Null())])).toThrow();
  });
});

it("reads the CRL Number and Delta CRL Indicator exactly and rejects negative or wrong-tag values", () => {
  const crlWith = (ext: pkijs.Extension) =>
    new pkijs.CertificateRevocationList({
      crlExtensions: new pkijs.Extensions({ extensions: [ext] }),
    });
  for (const oid of ["2.5.29.20", "2.5.29.27"]) {
    const large = 2n ** 100n + 123n;
    expect(getCRLInteger(crlWith(extension(oid, asn1.Integer.fromBigInt(large))), oid)).toBe(large);
    for (const value of [new asn1.Integer({ value: -1 }), new asn1.Enumerated({ value: 1 })]) {
      expect(
        () => getCRLInteger(crlWith(extension(oid, value)), oid),
        `${oid} ${value.constructor.name}`
      ).toThrow();
    }
  }
});
