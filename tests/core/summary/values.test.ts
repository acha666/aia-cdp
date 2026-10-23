import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { SIGNATURE_ALG_NAMES } from "../../../src/core/pki/constants.ts";
import { parseCertificate } from "../../../src/core/pki/parsers.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import {
  buildAlgorithmIdentifier,
  buildName,
  buildSubjectPublicKeyInfo,
  escapeRdnValue,
} from "../../../src/core/summary/primitives.ts";
import { cert, fixture } from "../../fixtures/pki.ts";
import { attribute, nameOf } from "../../helpers/pki.ts";

// The values of the X.509 detail other than extensions: algorithms, names, keys, versions.

const spkiOf = (name: string) => parseCertificate(fixture(cert(name).der)).subjectPublicKeyInfo;

it("decodes NULL, named curve and RSASSA-PSS algorithm parameters", () => {
  const algorithm = (algorithmId: string, algorithmParams: asn1.BaseBlock) =>
    new pkijs.AlgorithmIdentifier({ algorithmId, algorithmParams });
  expect(
    buildAlgorithmIdentifier(
      algorithm("1.2.840.113549.1.1.11", new asn1.Null()),
      SIGNATURE_ALG_NAMES
    )
  ).toEqual({
    algorithm: { oid: "1.2.840.113549.1.1.11", name: "sha256WithRSAEncryption" },
    parameters: { rawHex: "0500", parsed: { type: "null" } },
  });
  expect(
    buildAlgorithmIdentifier(
      algorithm("1.2.840.10045.2.1", new asn1.ObjectIdentifier({ value: "1.2.840.10045.3.1.7" }))
    ).parameters?.parsed
  ).toEqual({ type: "objectIdentifier", oid: { oid: "1.2.840.10045.3.1.7", name: "P-256" } });
  const sha256 = new pkijs.AlgorithmIdentifier({
    algorithmId: "2.16.840.1.101.3.4.2.1",
    algorithmParams: new asn1.Null(),
  });
  const pss = new pkijs.RSASSAPSSParams({
    hashAlgorithm: sha256,
    maskGenAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: "1.2.840.113549.1.1.8",
      algorithmParams: sha256.toSchema(),
    }),
    saltLength: 32,
  });
  const reparsed = asn1.fromBER(pss.toSchema().toBER(false)).result;
  expect(
    buildAlgorithmIdentifier(algorithm("1.2.840.113549.1.1.10", reparsed), SIGNATURE_ALG_NAMES)
  ).toEqual({
    algorithm: { oid: "1.2.840.113549.1.1.10", name: "RSASSA-PSS" },
    parameters: {
      rawHex: expect.any(String) as unknown,
      parsed: {
        type: "rsassaPss",
        hashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
        maskGenAlgorithm: { oid: "1.2.840.113549.1.1.8", name: "MGF1" },
        maskGenHashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
        saltLength: 32,
        trailerField: 1,
      },
    },
  });
});

describe("distinguished names", () => {
  it("report encodings, keep multi-attribute RDNs, escape RFC 4514 specials and keep raw non-strings", () => {
    const built = buildName(
      nameOf(
        [attribute("2.5.4.6", new asn1.PrintableString({ value: "CA" }))],
        [
          attribute("0.9.2342.19200300.100.1.25", new asn1.IA5String({ value: "example" })),
          attribute("2.5.4.10", new asn1.BmpString({ value: "Acme, Inc. " })),
        ],
        [attribute("2.5.4.5", new asn1.Integer({ value: 7 }))],
        [attribute("2.5.4.3", new asn1.TeletexString({ value: "#1 <Root>" }))]
      )
    );
    expect(built.rdnSequence.map((rdn) => rdn.attributes.map((a) => a.value.encoding))).toEqual([
      ["printableString"],
      ["ia5String", "bmpString"],
      ["unknown"],
      ["teletexString"],
    ]);
    expect(built.rdnSequence[2]?.attributes[0]?.value).toMatchObject({
      string: null,
      rawHex: "020107",
    });
    expect(built.rfc4514).toBe(
      "CN=\\#1 \\<Root\\>,serialNumber=#020107,DC=example+O=Acme\\, Inc.\\ ,C=CA"
    );
    expect(built.commonName).toBe("#1 <Root>");
    expect(escapeRdnValue(" lead")).toBe("\\ lead");
    expect(escapeRdnValue("a\\b;c")).toBe("a\\\\b\\;c");
  });

  it("label title, description, businessCategory and postalCode by their attribute names", () => {
    const utf8 = (value: string) => new asn1.Utf8String({ value });
    const name = nameOf(
      [attribute("2.5.4.17", utf8("8001"))],
      [attribute("2.5.4.15", utf8("Private Organization"))],
      [attribute("2.5.4.13", utf8("Test CA"))],
      [attribute("2.5.4.12", utf8("Operator"))],
      [attribute("2.5.4.3", utf8("Example"))]
    );
    expect(buildName(name).rfc4514).toBe(
      "CN=Example,title=Operator,description=Test CA,businessCategory=Private Organization,postalCode=8001"
    );
  });
});

describe("public keys", () => {
  it("reads the RSA modulus size and exponent of certs/issuing-ca-1", async () => {
    expect((await buildSubjectPublicKeyInfo(spkiOf("issuing-ca-1"))).parsed).toEqual({
      type: "rsa",
      // Without the INTEGER's sign octet.
      modulus: { hex: expect.stringMatching(/^[0-9A-F]{512}$/) as unknown, bitLength: 2048 },
      publicExponent: 65537,
    });
  });

  it("reports 521 bits and 66-octet coordinates for a P-521 key", async () => {
    const { publicKey } = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-521" },
      true,
      ["sign", "verify"]
    );
    const spki = pkijs.PublicKeyInfo.fromBER(await crypto.subtle.exportKey("spki", publicKey));
    const coordinate = expect.stringMatching(/^[0-9A-F]{132}$/) as unknown;
    expect((await buildSubjectPublicKeyInfo(spki)).parsed).toMatchObject({
      type: "ec",
      curve: { oid: "1.3.132.0.35", name: "P-521" },
      point: { x: coordinate, y: coordinate },
      keySize: 521,
    });
  });

  it("fingerprints the DER of the SubjectPublicKeyInfo", async () => {
    const spki = spkiOf("root-ca");
    const der = new Uint8Array(spki.toSchema().toBER(false));
    const hex = async (algorithm: string) =>
      Buffer.from(await crypto.subtle.digest(algorithm, der)).toString("hex");
    expect((await buildSubjectPublicKeyInfo(spki)).fingerprints).toEqual({
      sha1: await hex("SHA-1"),
      sha256: await hex("SHA-256"),
    });
  });
});

it("shows the CRL version explicitly", () => {
  const crl = new pkijs.CertificateRevocationList({ version: 1 });
  expect(buildTBSCertList(crl).version).toEqual({ raw: 1, display: "v2" });
  crl.version = 0;
  expect(buildTBSCertList(crl).version).toEqual({ raw: 0, display: "v1" });
});
