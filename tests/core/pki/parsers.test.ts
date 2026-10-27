import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  getAuthorityKeyIdHex,
  getCRLInteger,
  parseCertificate,
  parseCRL,
  parseCrlHeader,
} from "../../../src/core/pki/parsers.ts";
import { fixture } from "../../fixtures/pki.ts";
import { berVariants, extension, pkiError } from "../../helpers/pki.ts";

const ROOT = "certs/root-ca.der";

describe("parseCertificate / parseCRL", () => {
  it("rejects undecodable DER, trailing bytes, a bad time and a value of the wrong type", () => {
    // parseCrlHeader (the upload path) splits the TLVs with its own checks before it decodes.
    for (const [kind, parse] of [
      ["certificate", parseCertificate],
      ["crl", parseCRL],
      ["crl", parseCrlHeader],
    ] as const) {
      expect(() => parse(fixture("invalid/truncated.der"))).toThrow(pkiError(kind, "der"));
      const trailing =
        kind === "crl"
          ? fixture("invalid/trailing-byte.der")
          : Uint8Array.from([...fixture(ROOT), 0]);
      expect(() => parse(trailing)).toThrow(pkiError(kind, "trailing_bytes"));
    }
    // thisUpdate is a UTCTime without seconds; the signature is valid.
    expect(() => parseCRL(fixture("crls/issuing-ca-1/full-bad-time.der"))).toThrow(
      pkiError("crl", "time")
    );
    expect(() => parseCRL(fixture("invalid/certificate.der"))).toThrow(
      pkiError("crl", "structure")
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
      pkiError("certificate", "trailing_bytes")
    );
  });

  // A BER re-encoding of the unsigned outer SEQUENCE leaves the TBS and the signature intact: one
  // CRL under several digests.
  it("rejects BER encodings of a CRL's outer SEQUENCE as a DER error", () => {
    for (const [variant, bytes] of berVariants(fixture("crls/issuing-ca-1/full-01.der"))) {
      expect(() => parseCRL(bytes), variant).toThrow(pkiError("crl", "der"));
    }
  });

  // asn1js reads the last RDN past the issuer's end, so it still sees the CRL as it was, revoked
  // list included, where the TLV split of parseCrlHeader sees none: parseCRL would skip the entries.
  it("rejects a CRL whose issuer is one octet shorter than its RDNs", () => {
    const der = fixture("crls/issuing-ca-1/full-01.der").slice();
    der[26] = 72; // the issuer's length, 73 in the fixture
    for (const parse of [parseCrlHeader, parseCRL]) {
      expect(() => parse(der)).toThrow(pkiError("crl", "der"));
    }
  });

  // Without the revoked list, a nextUpdate after it would be read as the nextUpdate of the header.
  it("rejects a CRL with a field between revokedCertificates and crlExtensions", () => {
    const crl = fixture("crls/issuing-ca-1/full-01.der");
    const [nextUpdate, revoked] = [crl.subarray(115, 130), crl.subarray(130, 193)];
    const der = Uint8Array.from([
      ...crl.subarray(0, 115),
      ...revoked,
      ...nextUpdate,
      ...crl.subarray(193),
    ]);
    for (const parse of [parseCrlHeader, parseCRL]) {
      expect(() => parse(der)).toThrow(pkiError("crl", "structure"));
    }
  });
});

describe("key identifiers", () => {
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
    // The three fields in their order and nothing else (RFC 5280 §4.2.1.1).
    const tagged = (tagNumber: number, ...bytes: number[]) =>
      new asn1.Primitive({
        idBlock: { tagClass: 3, tagNumber },
        valueHex: Uint8Array.from(bytes).buffer,
      });
    for (const value of [
      [tagged(2, 17), tagged(0, 0xab, 0xcd)],
      [tagged(0, 0xab, 0xcd), new asn1.Null()],
    ]) {
      expect(() =>
        getAuthorityKeyIdHex([extension("2.5.29.35", new asn1.Sequence({ value }))])
      ).toThrow();
    }
  });
});

it("reads CRL numbers exactly and rejects negative, oversized or wrong-tag upload values", () => {
  const crlWith = (ext: pkijs.Extension) =>
    new pkijs.CertificateRevocationList({
      crlExtensions: new pkijs.Extensions({ extensions: [ext] }),
    });
  for (const oid of ["2.5.29.20", "2.5.29.27"]) {
    const large = 2n ** 100n + 123n;
    expect(getCRLInteger(crlWith(extension(oid, asn1.Integer.fromBigInt(large))), oid)).toBe(large);
    for (const value of [
      new asn1.Integer({ value: -1 }),
      asn1.Integer.fromBigInt(2n ** 200n),
      new asn1.Enumerated({ value: 1 }),
    ]) {
      expect(
        () => getCRLInteger(crlWith(extension(oid, value)), oid),
        `${oid} ${value.constructor.name}`
      ).toThrow();
    }
  }
});
