import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  getAuthorityKeyIdHex,
  getCommonName,
  getCRLNumber,
  getDeltaBaseCRLNumber,
  parseCertificate,
  parseCRL,
} from "../../../src/core/pki/parsers.ts";
import { fixture } from "../../fixtures/pki.ts";
import { berVariants, extension, pkiError } from "../../helpers/pki.ts";

const ROOT = "certs/root-ca.der";

describe("parseCertificate / parseCRL", () => {
  it("rejects undecodable DER, trailing bytes and a value of the wrong type", async () => {
    for (const [kind, parse] of [
      ["certificate", parseCertificate],
      ["crl", parseCRL],
    ] as const) {
      expect(await pkiError(() => parse(fixture("invalid/truncated.der")))).toEqual({
        kind,
        reason: "der",
      });
      const der = fixture(kind === "crl" ? "crls/root-ca/full-01.der" : ROOT);
      expect(await pkiError(() => parse(Uint8Array.from([...der, 0])))).toEqual({
        kind,
        reason: "trailing_bytes",
      });
    }
    expect(await pkiError(() => parseCRL(fixture("invalid/certificate.der")))).toEqual({
      kind: "crl",
      reason: "structure",
    });
  });

  // Node's Buffer pool hands out views into a larger buffer.
  it("decodes exactly the bytes of an offset view", async () => {
    const der = fixture(ROOT);
    const padded = new Uint8Array(der.length + 8).fill(0xff);
    padded.set(der, 4);
    const view = padded.subarray(4, 4 + der.length);
    expect(new Uint8Array(parseCertificate(view).toSchema().toBER(false))).toEqual(der);
    expect(await pkiError(() => parseCertificate(padded.subarray(4, 5 + der.length)))).toEqual({
      kind: "certificate",
      reason: "trailing_bytes",
    });
  });

  // A BER re-encoding of the unsigned outer SEQUENCE leaves the TBS and the signature intact: one
  // CA under several ids, one CRL under several digests.
  it("rejects BER encodings of the outer SEQUENCE as a DER error", async () => {
    for (const [kind, file, parse] of [
      ["certificate", "certs/issuing-ca-1.der", parseCertificate],
      ["crl", "crls/issuing-ca-1/full-01.der", parseCRL],
    ] as const) {
      for (const [variant, bytes] of berVariants(fixture(file))) {
        expect(await pkiError(() => parse(bytes)), `${kind}: ${variant}`).toEqual({
          kind,
          reason: "der",
        });
      }
    }
  });
});

describe("names and key identifiers", () => {
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

  it("takes the first CN in RDN order, and none whose value is not a string", () => {
    const name = nameOf(
      ["2.5.4.10", new asn1.Utf8String({ value: "Example" })],
      ["2.5.4.3", new asn1.BmpString({ value: "First" })],
      ["2.5.4.3", new asn1.Utf8String({ value: "Second" })]
    );
    expect(getCommonName(name)).toBe("First");
    expect(getCommonName(nameOf(["2.5.4.3", new asn1.Integer({ value: 7 })]))).toBeUndefined();
    expect(getCommonName(nameOf(["2.5.4.10", new asn1.Utf8String({ value: "Example" })]))).toBe(
      undefined
    );
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
  for (const [oid, read] of [
    ["2.5.29.20", getCRLNumber],
    ["2.5.29.27", getDeltaBaseCRLNumber],
  ] as const) {
    const large = 2n ** 100n + 123n;
    expect(read(crlWith(extension(oid, asn1.Integer.fromBigInt(large))))).toBe(large);
    for (const value of [new asn1.Integer({ value: -1 }), new asn1.Enumerated({ value: 1 })]) {
      expect(
        () => read(crlWith(extension(oid, value))),
        `${oid} ${value.constructor.name}`
      ).toThrow();
    }
  }
});
