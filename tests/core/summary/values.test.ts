import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { toHex } from "../../../src/core/pki/conversion.ts";
import { parseCertificate, parseCRL } from "../../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../../src/core/summary/certificate.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { buildExtension } from "../../../src/core/summary/extensions.ts";
import {
  buildAlgorithmIdentifier,
  buildName,
  buildSubjectPublicKeyInfo,
} from "../../../src/core/summary/primitives.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import type { ManifestCertificate } from "../../fixtures/pki.ts";
import { extension, pkiError } from "../../helpers/pki.ts";

// The builder cases of worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts (L28, L96, L111,
// L124, L181, L202, and the builder halves of L55 and L75); its parser cases are in
// tests/core/pki/parsers.test.ts (slice 2) and its upload case in tests/core/publish.test.ts
// (slice 4). L224 tested the builders' options to skip extensions and revocations, which are gone
// (slice 5a step 3). The fixture root is EC P-384 now (the old one was RSA-2048): the RSA key comes
// from certs/issuing-ca-1, and the algorithm assertions follow certs/root-ca. Plus the DN labels of
// slice 5a step 4, and integers of four contents octets and more (slice 5a review).

function certificateEntry(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest entry for ${name}`);
  }
  return found;
}

function parsedOf(oid: string, value: { toBER(sizeOnly?: boolean): ArrayBuffer }) {
  const result = buildExtension(extension(oid, value));
  expect(result.parseStatus, `${oid}: ${result.parseError}`).toBe("parsed");
  return result.parsed!;
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

  it("AKI keeps the key identifier, the issuer names and the serial number (hex)", () => {
    const aki = new pkijs.AuthorityKeyIdentifier({
      keyIdentifier: new asn1.OctetString({ valueHex: Uint8Array.of(0xab, 0xcd).buffer }),
      authorityCertIssuer: [new pkijs.GeneralName({ type: 6, value: "https://ca.example/issuer" })],
      authorityCertSerialNumber: new asn1.Integer({ value: 17 }),
    });
    const result = buildExtension(extension("2.5.29.35", aki.toSchema()));
    expect(result.parseStatus).toBe("parsed");
    expect(result.parsed).toEqual({
      extensionType: "authorityKeyIdentifier",
      keyIdentifier: "ABCD",
      authorityCertSerialNumber: "11",
      authorityCertIssuer: [
        { type: "uniformResourceIdentifier", value: "https://ca.example/issuer" },
      ],
    });
  });

  it("CRL integers preserve precision and reject negative or wrong-tag values", () => {
    for (const [oid, field] of [
      ["2.5.29.20", "number"],
      ["2.5.29.27", "baseCRLNumber"],
    ] as const) {
      const large = 2n ** 100n + 123n;
      const result = buildExtension(extension(oid, asn1.Integer.fromBigInt(large)));
      expect(result.parseStatus, oid).toBe("parsed");
      expect(result.parsed, oid).toMatchObject({ [field]: "1267650600228229401496703205499" });
      for (const value of [
        new asn1.Integer({ value: -1 }),
        new asn1.Enumerated({ value: 1 }),
        new asn1.OctetString({ valueHex: Uint8Array.of(1).buffer }),
      ]) {
        const bad = buildExtension(extension(oid, value));
        expect(bad.parseStatus, `${oid} ${value.constructor.name}`).toBe("error");
        expect(bad.parsed).toBeUndefined();
      }
    }
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

  it("invalidity date keeps a GeneralizedTime year before 100 (not 19xx)", () => {
    const time = new asn1.Primitive({
      idBlock: { tagClass: 1, tagNumber: 24 },
      valueHex: new TextEncoder().encode("00010101000000Z").buffer,
    });
    expect(buildExtension(extension("2.5.29.24", time)).parsed).toEqual({
      extensionType: "invalidityDate",
      date: { iso: "0001-01-01T00:00:00.000Z", type: "generalizedTime", raw: "00010101000000Z" },
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

// asn1js sets valueDec to 0 for INTEGER and ENUMERATED contents of four octets or more (from 2^23
// on), and PKIjs copies valueDec into its numeric fields. Numbers are read from the contents
// instead: exactly while they are safe integers, a parse error (with the dump) beyond.
describe("INTEGER and ENUMERATED values of four contents octets and more", () => {
  const FOUR_OCTETS = 2 ** 23; // 00 80 00 00
  const SIX_OCTETS = 2 ** 40; // 01 00 00 00 00 00
  const UNSAFE = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

  /** The contents octets of the INTEGER `value`, for implicitly tagged fields. */
  function contents(value: bigint): ArrayBuffer {
    return asn1.Integer.fromBigInt(value).valueBlock.valueHexView.slice().buffer;
  }

  function explicit(tagNumber: number, value: asn1.BaseBlock): asn1.Constructed {
    return new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });
  }

  it("dump them in decimal, exactly", () => {
    const dump = buildExtension(
      extension(
        "1.2.3.4",
        new asn1.Sequence({
          value: [
            new asn1.Integer({ value: FOUR_OCTETS }),
            new asn1.Integer({ value: -FOUR_OCTETS - 1 }),
            asn1.Integer.fromBigInt(2n ** 100n + 123n),
            new asn1.Enumerated({ value: 2 ** 31 }),
          ],
        })
      )
    ).asn1;
    expect(dump?.slice(1).map((line) => [line.tag, line.value])).toEqual([
      ["INTEGER", "8388608"],
      ["INTEGER", "-8388609"],
      ["INTEGER", "1267650600228229401496703205499"],
      ["ENUMERATED", "2147483648"],
    ]);
  });

  it("decode the numeric fields of the extensions", () => {
    expect(
      parsedOf(
        "2.5.29.19",
        new pkijs.BasicConstraints({ cA: true, pathLenConstraint: SIX_OCTETS }).toSchema()
      )
    ).toEqual({ extensionType: "basicConstraints", cA: true, pathLenConstraint: SIX_OCTETS });
    expect(parsedOf("2.5.29.54", new asn1.Integer({ value: FOUR_OCTETS }))).toEqual({
      extensionType: "inhibitAnyPolicy",
      skipCerts: FOUR_OCTETS,
    });
    expect(
      parsedOf(
        "1.3.6.1.5.5.7.1.24",
        new asn1.Sequence({ value: [new asn1.Integer({ value: 2 ** 31 })] })
      )
    ).toEqual({ extensionType: "tlsFeature", features: [{ code: 2 ** 31, name: null }] });
    expect(
      parsedOf(
        "2.5.29.36",
        new pkijs.PolicyConstraints({
          requireExplicitPolicy: FOUR_OCTETS,
          inhibitPolicyMapping: SIX_OCTETS,
        }).toSchema()
      )
    ).toEqual({
      extensionType: "policyConstraints",
      requireExplicitPolicy: FOUR_OCTETS,
      inhibitPolicyMapping: SIX_OCTETS,
    });
    expect(
      parsedOf(
        "1.3.6.1.4.1.311.21.7",
        new pkijs.CertificateTemplate({
          templateID: "1.3.6.1.4.1.311.21.8.1.2.3",
          templateMajorVersion: FOUR_OCTETS,
          templateMinorVersion: SIX_OCTETS,
        }).toSchema()
      )
    ).toMatchObject({ majorVersion: FOUR_OCTETS, minorVersion: SIX_OCTETS });
    expect(parsedOf("2.5.29.21", new asn1.Enumerated({ value: FOUR_OCTETS }))).toEqual({
      extensionType: "cRLReason",
      code: FOUR_OCTETS,
      name: `reason_${FOUR_OCTETS}`,
    });
    const constraints = new pkijs.NameConstraints({
      permittedSubtrees: [
        new pkijs.GeneralSubtree({
          base: new pkijs.GeneralName({ type: 2, value: "example.com" }),
          minimum: FOUR_OCTETS,
          maximum: SIX_OCTETS,
        }),
      ],
    });
    expect(parsedOf("2.5.29.30", constraints.toSchema())).toMatchObject({
      permittedSubtrees: [{ minimum: FOUR_OCTETS, maximum: SIX_OCTETS }],
    });
  });

  it.each<[string, string, asn1.BaseBlock]>([
    [
      "pathLenConstraint",
      "2.5.29.19",
      new asn1.Sequence({
        value: [new asn1.Boolean({ value: true }), asn1.Integer.fromBigInt(UNSAFE)],
      }),
    ],
    ["skipCerts", "2.5.29.54", asn1.Integer.fromBigInt(UNSAFE)],
    [
      "a TLS feature",
      "1.3.6.1.5.5.7.1.24",
      new asn1.Sequence({ value: [asn1.Integer.fromBigInt(UNSAFE)] }),
    ],
    [
      "requireExplicitPolicy",
      "2.5.29.36",
      new asn1.Sequence({
        value: [
          new asn1.Primitive({
            idBlock: { tagClass: 3, tagNumber: 0 },
            valueHex: contents(UNSAFE),
          }),
        ],
      }),
    ],
    [
      "a template version",
      "1.3.6.1.4.1.311.21.7",
      new asn1.Sequence({
        value: [new asn1.ObjectIdentifier({ value: "1.2.3" }), asn1.Integer.fromBigInt(UNSAFE)],
      }),
    ],
    ["a reason code", "2.5.29.21", new asn1.Enumerated({ valueHex: contents(UNSAFE) })],
    [
      "a subtree maximum",
      "2.5.29.30",
      new pkijs.NameConstraints({
        permittedSubtrees: [
          new pkijs.GeneralSubtree({
            base: new pkijs.GeneralName({ type: 2, value: "example.com" }),
            maximum: asn1.Integer.fromBigInt(UNSAFE),
          }),
        ],
      }).toSchema(),
    ],
  ])("report %s beyond Number.MAX_SAFE_INTEGER as an error with the dump", (_, oid, value) => {
    const result = buildExtension(extension(oid, value));
    expect(result.parseStatus).toBe("error");
    expect(result.parsed).toBeUndefined();
    expect(result.parseError).toMatch(/beyond Number\.MAX_SAFE_INTEGER/);
    // The dump has the value: an INTEGER in decimal, an implicitly tagged one as its octets.
    const shown = [UNSAFE.toString(), toHex(new Uint8Array(contents(UNSAFE))).toUpperCase()];
    expect(result.asn1?.some((line) => shown.includes(line.value ?? ""))).toBe(true);
  });

  it("decode RSASSA-PSS saltLength and trailerField", () => {
    const parameters = (saltLength: asn1.Integer, trailerField: asn1.Integer) =>
      new asn1.Sequence({ value: [explicit(2, saltLength), explicit(3, trailerField)] });
    const parsed = buildAlgorithmIdentifier(
      "1.2.840.113549.1.1.10",
      parameters(new asn1.Integer({ value: FOUR_OCTETS }), new asn1.Integer({ value: SIX_OCTETS }))
    ).parameters?.parsed;
    expect(parsed).toMatchObject({
      type: "rsassaPss",
      saltLength: FOUR_OCTETS,
      trailerField: SIX_OCTETS,
    });
    // Beyond a safe integer the parameters keep their raw form only, like any undecodable ones.
    const unsafe = buildAlgorithmIdentifier(
      "1.2.840.113549.1.1.10",
      parameters(asn1.Integer.fromBigInt(UNSAFE), new asn1.Integer({ value: 1 }))
    );
    expect(unsafe.parameters?.rawHex).toMatch(/^30/);
    expect(unsafe.parameters?.parsed).toBeUndefined();
  });

  it("read the TBS version of a certificate and a CRL", async () => {
    /** `der` re-encoded from its fields with the version INTEGER `version` (signatures break). */
    function withVersion(der: Uint8Array, kind: "certificate" | "crl", version: asn1.Integer) {
      const parsed = kind === "certificate" ? parseCertificate(der) : parseCRL(der);
      // PKIjs types toSchema(true) as any.
      const schema = parsed.toSchema(true) as asn1.Sequence;
      const tbs = schema.valueBlock.value[0] as asn1.Sequence;
      tbs.valueBlock.value[0] = kind === "certificate" ? explicit(0, version) : version;
      return new Uint8Array(schema.toBER(false));
    }
    const certificate = fixture(certificateEntry("root-ca").der);
    const crl = fixture("crls/issuing-ca-1/full-01.der");

    const tbsCertificate = await buildTBSCertificate(
      parseCertificate(
        withVersion(certificate, "certificate", new asn1.Integer({ value: SIX_OCTETS }))
      )
    );
    expect(tbsCertificate.version).toEqual({ raw: SIX_OCTETS, display: "v3" });
    expect(
      buildTBSCertList(parseCRL(withVersion(crl, "crl", new asn1.Integer({ value: FOUR_OCTETS }))))
        .version
    ).toEqual({ raw: FOUR_OCTETS, display: "v3" });

    expect(
      await pkiError(() =>
        parseCertificate(withVersion(certificate, "certificate", asn1.Integer.fromBigInt(UNSAFE)))
      )
    ).toEqual({ kind: "certificate", reason: "structure" });
    expect(
      await pkiError(() => parseCRL(withVersion(crl, "crl", asn1.Integer.fromBigInt(UNSAFE))))
    ).toEqual({ kind: "crl", reason: "structure" });
  });
});
