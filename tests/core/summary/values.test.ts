import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { parseCertificate } from "../../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../../src/core/summary/certificate.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { buildExtension } from "../../../src/core/summary/extensions.ts";
import { buildName, buildSubjectPublicKeyInfo } from "../../../src/core/summary/primitives.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import type { ManifestCertificate } from "../../fixtures/pki.ts";
import { extension } from "../../helpers/pki.ts";

// The builder cases of worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts (L28, L96, L111,
// L124, L181, L202); its parser cases are in tests/core/pki/parsers.test.ts (slice 2) and its
// upload case in tests/core/publish.test.ts (slice 4). L224 tested the builders' options to skip
// extensions and revocations, which are gone (slice 5a step 3). The fixture root is EC P-384 now
// (the old one was RSA-2048): the RSA key comes from certs/issuing-ca-1, and the algorithm
// assertions follow certs/root-ca. Plus the DN labels of slice 5a step 4.

function certificateEntry(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest entry for ${name}`);
  }
  return found;
}

/** A Name with one single-attribute RDN per [type, value], in order. */
function nameOf(...rdns: [string, string][]): pkijs.RelativeDistinguishedNames {
  const sequence = new asn1.Sequence({
    value: rdns.map(
      ([type, value]) =>
        new asn1.Set({
          value: [
            new pkijs.AttributeTypeAndValue({
              type,
              value: new asn1.Utf8String({ value }),
            }).toSchema(),
          ],
        })
    ),
  });
  return new pkijs.RelativeDistinguishedNames({
    schema: asn1.fromBER(sequence.toBER(false)).result,
  });
}

describe("extension values", () => {
  it("SAN renders IPv4 and IPv6 from PKIjs OctetString values", () => {
    const san = new pkijs.AltName({
      altNames: [
        new pkijs.GeneralName({
          type: 7,
          value: new asn1.OctetString({ valueHex: Uint8Array.of(192, 0, 2, 1).buffer }),
        }),
        new pkijs.GeneralName({
          type: 7,
          value: new asn1.OctetString({
            valueHex: Uint8Array.from([0x20, 1, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
              .buffer,
          }),
        }),
      ],
    });
    expect(buildExtension(extension("2.5.29.17", san.toSchema())).parsed).toEqual({
      extensionType: "subjectAltName",
      names: [
        { type: "iPAddress", value: "192.0.2.1" },
        { type: "iPAddress", value: "2001:db8::1" },
      ],
    });
  });

  it("malformed known extensions report errors; unknown extensions retain raw bytes", () => {
    for (const oid of ["2.5.29.19", "2.5.29.35", "2.5.29.37", "2.5.29.31", "1.3.6.1.5.5.7.1.1"]) {
      const result = buildExtension(extension(oid, new asn1.Null()));
      expect(result.parseStatus, oid).toBe("error");
      expect(result.extnValue.hex).toBe("0500");
    }
    expect(buildExtension(extension("1.2.3.4", new asn1.Null())).parseStatus).toBe("unsupported");
    expect(
      buildExtension(
        new pkijs.Extension({ extnID: "2.5.29.19", extnValue: Uint8Array.of(0xff).buffer })
      ).parseStatus
    ).toBe("error");
  });

  it("invalidity date is a GeneralizedTime with a usable ISO value", () => {
    const result = buildExtension(
      extension(
        "2.5.29.24",
        new asn1.GeneralizedTime({ valueDate: new Date("2026-01-02T03:04:05Z") })
      )
    );
    expect(result.parsed).toEqual({
      extensionType: "invalidityDate",
      date: { iso: "2026-01-02T03:04:05.000Z", type: "generalizedTime", raw: "20260102030405Z" },
    });
  });
});

describe("public keys", () => {
  it("reads the RSA modulus size and exponent of certs/issuing-ca-1", async () => {
    const entry = certificateEntry("issuing-ca-1");
    const cert = parseCertificate(fixture(entry.der));
    // manifest key "rsa-2048": the size is part of the fixture contract (appendix D).
    const bits = Number(/^rsa-(\d+)$/.exec(entry.key)?.[1]);
    expect((await buildSubjectPublicKeyInfo(cert.subjectPublicKeyInfo)).parsed).toEqual({
      type: "rsa",
      // Without the INTEGER's sign octet.
      modulus: {
        hex: expect.stringMatching(new RegExp(`^[0-9A-F]{${bits / 4}}$`)) as unknown,
        bitLength: bits,
      },
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
    const cert = parseCertificate(fixture(certificateEntry("root-ca").der));
    const { fingerprints } = await buildSubjectPublicKeyInfo(cert.subjectPublicKeyInfo);
    const spki = new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false));
    const hex = async (algorithm: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, spki)), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    expect(fingerprints).toEqual({ sha1: await hex("SHA-1"), sha256: await hex("SHA-256") });
  });
});

describe("TBS builders", () => {
  it("preserve inner signature algorithms and explicit CRL versions", async () => {
    const crl = new pkijs.CertificateRevocationList({
      version: 1,
      signature: new pkijs.AlgorithmIdentifier({ algorithmId: "1.2.3" }),
      signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: "1.2.4" }),
    });
    expect(buildTBSCertList(crl).version.display).toBe("v2");
    expect(buildTBSCertList(crl).signature.algorithm.oid).toBe("1.2.3");
    crl.version = 0;
    expect(buildTBSCertList(crl).version).toEqual({ raw: 0, display: "v1" });

    // root-ca signs itself with ecdsa-with-SHA384 (appendix D), parameters absent.
    const cert = parseCertificate(fixture(certificateEntry("root-ca").der));
    expect((await buildTBSCertificate(cert)).signature).toEqual({
      algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
    });
    cert.signature.algorithmId = "1.2.3";
    expect((await buildTBSCertificate(cert)).signature.algorithm).toEqual({
      oid: "1.2.3",
      name: null,
    });
  });
});

describe("distinguished names", () => {
  it("preserve multi-attribute RDN sets and their ordering", () => {
    const attribute = (type: string, value: string) =>
      new pkijs.AttributeTypeAndValue({ type, value: new asn1.Utf8String({ value }) }).toSchema();
    const name = new pkijs.RelativeDistinguishedNames({
      schema: asn1.fromBER(
        new asn1.Sequence({
          value: [
            new asn1.Set({
              value: [attribute("2.5.4.10", "Example"), attribute("2.5.4.11", "CA")],
            }),
            new asn1.Set({ value: [attribute("2.5.4.3", "Root")] }),
          ],
        }).toBER(false)
      ).result,
    });
    const result = buildName(name);
    expect(result.rdnSequence.map((rdn) => rdn.attributes.map((a) => a.value.string))).toEqual([
      ["Example", "CA"],
      ["Root"],
    ]);
    expect(result.commonName).toBe("Root");
  });

  // Slice 5a step 4: no T / DESCRIPTION / BUSINESS / POSTAL; OpenSSL has no short name either.
  it("label title, description, businessCategory and postalCode by their attribute names", () => {
    const name = nameOf(
      ["2.5.4.17", "8001"],
      ["2.5.4.15", "Private Organization"],
      ["2.5.4.13", "Test CA"],
      ["2.5.4.12", "Operator"],
      ["2.5.4.3", "Example"]
    );
    expect(buildName(name).rfc4514).toBe(
      "CN=Example,title=Operator,description=Test CA,businessCategory=Private Organization,postalCode=8001"
    );
  });
});
