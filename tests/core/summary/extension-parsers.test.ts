import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { dumpAsn1, formatGeneralizedTime, readStrictTime } from "../../../src/core/pki/asn1.ts";
import { SIGNATURE_ALG_NAMES } from "../../../src/core/pki/constants.ts";
import { toHex } from "../../../src/core/pki/conversion.ts";
import { parseCertificate, parseCRL } from "../../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../../src/core/summary/certificate.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { buildExtension, buildExtensions } from "../../../src/core/summary/extensions.ts";
import {
  buildAlgorithmIdentifier,
  buildName,
  buildSignatureValue,
  escapeRdnValue,
} from "../../../src/core/summary/primitives.ts";
import type {
  Extension,
  ExtensionType,
  ParsedExtensionValue,
  RevokedCertificate,
} from "../../../src/core/summary/types.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import type { ManifestCertificate, ManifestCrl } from "../../fixtures/pki.ts";
import { extension } from "../../helpers/pki.ts";

// worker-aia-cdp@5b570aa:tests/worker/extension-parsers.test.ts. The 11 cases that build their own
// extension values are migrated as they were. The 6 that read the live pki.acha.top artifacts of
// tests/data/adcs.ts (L54, L87, L106, L151, L647, L683) run on the synthetic AD CS style fixtures
// instead (D7), with values from manifest.json or from the configuration of
// tests/fixtures/generate-test-data.sh; L647's strict time checks are in
// tests/core/pki/asn1.test.ts (slice 2), only its buildTBSCertList assertion is here. The last
// block fills gaps of the old tests: CRL entry extensions and EKU on fixtures, QC Statements, SCT
// List and Subject Directory Attributes built in the test.

function certificateEntry(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest entry for ${name}`);
  }
  return found;
}

function crlEntry(file: string): ManifestCrl {
  const found = manifest.crls.find((c) => c.file === file);
  if (!found) {
    throw new Error(`no manifest entry for ${file}`);
  }
  return found;
}

function certificate(name: string): pkijs.Certificate {
  return parseCertificate(fixture(certificateEntry(name).der));
}

/** The Time projection of a manifest time (ISO 8601 UTC) that the fixture encodes as UTCTime. */
function utcTime(iso: string) {
  const date = new Date(iso);
  return { iso: date.toISOString(), type: "utcTime", raw: formatGeneralizedTime(date).slice(2) };
}

function parsedOf(oid: string, value: { toBER(sizeOnly?: boolean): ArrayBuffer }) {
  const result = buildExtension(extension(oid, value));
  expect(result.parseStatus, `${oid}: ${result.parseError}`).toBe("parsed");
  return result.parsed!;
}

/** `value` narrowed to the variant of `type`, after asserting that it is that variant. */
function variant<T extends ExtensionType>(
  value: ParsedExtensionValue | undefined,
  type: T
): Extract<ParsedExtensionValue, { extensionType: T }> {
  expect(value?.extensionType).toBe(type);
  return value as Extract<ParsedExtensionValue, { extensionType: T }>;
}

function byOid<T extends { extnID: { oid: string } }>(items: T[] | undefined, oid: string): T {
  const found = items?.find((item) => item.extnID.oid === oid);
  expect(found, `extension ${oid} present`).toBeDefined();
  return found!;
}

function uri(value: string) {
  return new pkijs.GeneralName({ type: 6, value });
}

function dns(value: string) {
  return new pkijs.GeneralName({ type: 2, value });
}

function ip(bytes: number[]) {
  return new pkijs.GeneralName({
    type: 7,
    value: new asn1.OctetString({ valueHex: Uint8Array.from(bytes).buffer }),
  });
}

/** Octets of an even-length hex string. */
function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function contextSequence(tagNumber: number, value: asn1.BaseBlock[]) {
  return new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value });
}

describe("AD CS shapes on the synthetic fixtures", () => {
  it("decodes every extension of certs/issuing-ca-1 including the Microsoft ones", async () => {
    const entry = certificateEntry("issuing-ca-1");
    const tbs = await buildTBSCertificate(parseCertificate(fixture(entry.der)));
    const items = tbs.extensions?.items ?? [];
    // ext_issuing of the generator, in its order (the AD CS SubCA template shape).
    expect(items.map((item) => [item.parseStatus, item.parsed?.extensionType])).toEqual(
      [
        "subjectKeyIdentifier",
        "authorityKeyIdentifier",
        "basicConstraints",
        "keyUsage",
        "authorityInfoAccess",
        "cRLDistributionPoints",
        "msCaVersion",
        "msCertificateTemplateName",
      ].map((type) => ["parsed", type])
    );
    expect(byOid(items, "1.3.6.1.4.1.311.21.1").parsed).toEqual({
      extensionType: "msCaVersion",
      certificateIndex: 0,
      keyIndex: 0,
    });
    expect(byOid(items, "1.3.6.1.4.1.311.21.1").extnID.name).toBe("CA Version");
    expect(byOid(items, "1.3.6.1.4.1.311.20.2").parsed).toEqual({
      extensionType: "msCertificateTemplateName",
      name: "SubCA",
    });
    // ICA1_SUBJ and ROOT_SUBJ of the generator, PrintableString (string mask pkix).
    expect(tbs.subject.rfc4514).toBe("CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US");
    expect(tbs.issuer.rfc4514).toBe("CN=Example Root CA (ECC P-384),O=Example PKI,C=US");
    expect(tbs.subject.rdnSequence[0]?.attributes[0]?.value.encoding).toBe("printableString");
    expect(tbs.validity.notBefore).toEqual(utcTime(entry.notBefore));
    expect(tbs.validity.notAfter).toEqual(utcTime(entry.notAfter));
    // Signed by root-ca: ECDSA, whose AlgorithmIdentifier has no parameters (RFC 5758 §3.2).
    expect(tbs.signature.algorithm.name).toBe("ecdsa-with-SHA384");
    expect(tbs.signature.parameters).toBeUndefined();
    expect(tbs.subjectPublicKeyInfo.parsed.type).toBe("rsa");
    expect(tbs.subjectPublicKeyInfo.algorithm.parameters).toEqual({
      rawHex: "0500",
      parsed: { type: "null" },
    });
    expect(tbs.issuerUniqueID).toBeUndefined();
  });

  it("exposes the named curve of certs/root-ca and its ECDSA (r, s) pair", async () => {
    const cert = certificate("root-ca");
    const tbs = await buildTBSCertificate(cert);
    expect(tbs.subjectPublicKeyInfo.algorithm.parameters?.parsed).toEqual({
      type: "objectIdentifier",
      oid: { oid: "1.3.132.0.34", name: "P-384" },
    });
    const signature = buildSignatureValue(cert.signatureValue, cert.signatureAlgorithm.algorithmId);
    const parsed = signature.parsed;
    expect(parsed?.type).toBe("ecdsa");
    // ECDSA signatures are random: r and s are at most 48 octets (P-384), unsigned, without the
    // INTEGER's sign octet; their lengths vary from signature to signature.
    for (const value of [parsed?.r, parsed?.s]) {
      expect(value).toMatch(/^[0-9A-F]+$/);
      expect(value!.length).toBeLessThanOrEqual(96);
      expect(value).not.toMatch(/^00/);
    }
    // leaf-full is signed by issuing-ca-1 (RSA): no (r, s) pair.
    const rsaSigned = certificate("leaf-full");
    const algorithm = rsaSigned.signatureAlgorithm.algorithmId;
    expect(SIGNATURE_ALG_NAMES[algorithm]).toBe("sha256WithRSAEncryption");
    expect(buildSignatureValue(rsaSigned.signatureValue, algorithm).parsed).toBeUndefined();
  });

  it("decodes Next CRL Publish, Freshest CRL and CRL Self CDP of crls/issuing-ca-1/full-adcs, in order", () => {
    const entry = crlEntry("crls/issuing-ca-1/full-adcs.der");
    const tbs = buildTBSCertList(parseCRL(fixture(entry.file)));
    const items = tbs.crlExtensions?.items ?? [];
    // crl_ext_adcs_full of the generator; openssl ca appends the CRL Number last.
    expect(items.map((item) => [item.extnID.oid, item.parseStatus])).toEqual([
      ["2.5.29.35", "parsed"],
      ["1.3.6.1.4.1.311.21.1", "parsed"],
      ["1.3.6.1.4.1.311.21.4", "parsed"],
      ["2.5.29.46", "parsed"],
      ["1.3.6.1.4.1.311.21.14", "parsed"],
      ["2.5.29.20", "parsed"],
    ]);
    expect(byOid(items, "1.3.6.1.4.1.311.21.4").parsed).toEqual({
      extensionType: "msCrlNextPublish",
      date: utcTime(entry.nextPublish!),
    });
    expect(byOid(items, "2.5.29.20").parsed).toEqual({
      extensionType: "cRLNumber",
      number: entry.crlNumber,
    });
    const freshest = variant(byOid(items, "2.5.29.46").parsed, "freshestCRL");
    const freshestNames = freshest.distributionPoints[0]?.distributionPoint?.fullName;
    expect(freshestNames?.map((name) => name.type)).toEqual([
      "uniformResourceIdentifier",
      "uniformResourceIdentifier",
    ]);
    expect(freshestNames?.[0]?.value).toBe("http://pki.example.test/dcrl/issuing-ca-1.crl");
    const selfCdp = variant(byOid(items, "1.3.6.1.4.1.311.21.14").parsed, "msCrlSelfCdp");
    expect(selfCdp.distributionPoints[0]?.distributionPoint?.fullName?.[0]?.value).toMatch(
      /^ldap:\/\/\/CN=Example%20Issuing%20CA%2001,/
    );
    expect(tbs.signature.parameters).toEqual({ rawHex: "0500", parsed: { type: "null" } });
    expect(tbs.thisUpdate).toEqual(utcTime(entry.thisUpdate));
  });

  it("keeps the critical Delta CRL Indicator of crls/issuing-ca-1/delta-adcs and its base number", () => {
    const entry = crlEntry("crls/issuing-ca-1/delta-adcs.der");
    const items = buildTBSCertList(parseCRL(fixture(entry.file))).crlExtensions?.items ?? [];
    const delta = byOid(items, "2.5.29.27");
    expect(delta.critical).toBe(true);
    expect(delta.parsed).toEqual({
      extensionType: "deltaCRLIndicator",
      baseCRLNumber: entry.baseCrlNumber,
    });
    expect(items.every((item) => item.asn1 === undefined)).toBe(true);
  });

  it("reports the received GeneralizedTime of thisUpdate as such", () => {
    const der = fixture("crls/root-ca/full-01.der");
    const original = parseCRL(der);
    expect(buildTBSCertList(original).thisUpdate).toEqual(
      utcTime(crlEntry("crls/root-ca/full-01.der").thisUpdate)
    );
    // thisUpdate replaced by a GeneralizedTime (the signature no longer matches; no check here).
    const crl = parseCRL(der);
    crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date("2026-05-08T00:00:00Z") });
    // PKIjs types CertificateRevocationList.toSchema() as any.
    const schema = crl.toSchema(true) as asn1.Sequence;
    const tbs = schema.valueBlock.value[0] as asn1.Sequence;
    const index = tbs.valueBlock.value.findIndex((block) => block instanceof asn1.UTCTime);
    // Raw primitive blocks keep arbitrary bytes; asn1js time classes would re-encode their fields.
    tbs.valueBlock.value[index] = new asn1.Primitive({
      idBlock: { tagClass: 1, tagNumber: 24 },
      valueHex: new TextEncoder().encode("20260508000000Z").buffer,
    });
    expect(buildTBSCertList(parseCRL(schema.toBER(false))).thisUpdate).toEqual({
      iso: "2026-05-08T00:00:00.000Z",
      type: "generalizedTime",
      raw: "20260508000000Z",
    });
  });

  it("counts the critical extensions of certs/issuing-ca-2 after the richer decoders run", () => {
    const extensions = buildExtensions(certificate("issuing-ca-2").extensions);
    // basicConstraints and keyUsage are critical in ext_issuing.
    expect(extensions?.critical).toBe(2);
    expect(
      extensions?.items.filter((item) => item.critical).map((item) => item.extnID.oid)
    ).toEqual(["2.5.29.19", "2.5.29.15"]);
    expect(extensions?.items.filter((item) => item.parseStatus !== "parsed")).toEqual([]);
  });
});

describe("extension decoders on values built in the test", () => {
  it("name constraints decode subtrees, IP masks and minimum/maximum", () => {
    const constraints = new pkijs.NameConstraints({
      permittedSubtrees: [
        new pkijs.GeneralSubtree({ base: dns("example.com") }),
        new pkijs.GeneralSubtree({ base: ip([192, 0, 2, 0, 255, 255, 255, 0]) }),
        new pkijs.GeneralSubtree({
          base: ip([
            0x20,
            1,
            0x0d,
            0xb8,
            ...new Array<number>(12).fill(0),
            ...new Array<number>(4).fill(255),
            ...new Array<number>(12).fill(0),
          ]),
        }),
      ],
      excludedSubtrees: [
        new pkijs.GeneralSubtree({
          base: new pkijs.GeneralName({ type: 1, value: "nobody@example.com" }),
          minimum: 1,
          maximum: 3,
        }),
      ],
    });
    const parsed = variant(parsedOf("2.5.29.30", constraints.toSchema()), "nameConstraints");
    expect(parsed.permittedSubtrees?.map((subtree) => subtree.base.value)).toEqual([
      "example.com",
      "192.0.2.0/24",
      "2001:db8::/32",
    ]);
    expect(parsed.excludedSubtrees?.[0]).toEqual({
      base: { type: "rfc822Name", value: "nobody@example.com" },
      minimum: 1,
      maximum: 3,
    });
  });

  it("issuing distribution point reads reason flags from the DER, not the PKIjs integer", () => {
    const idp = new pkijs.IssuingDistributionPoint({
      distributionPoint: [uri("http://crl.example/full.crl")],
      onlyContainsUserCerts: true,
      indirectCRL: true,
    });
    const schema = idp.toSchema();
    // Insert onlySomeReasons ::= [3] IMPLICIT ReasonFlags { keyCompromise, superseded } before [4].
    const indirectIndex = schema.valueBlock.value.findIndex(
      (block) => block.idBlock.tagNumber === 4
    );
    schema.valueBlock.value.splice(
      indirectIndex,
      0,
      new asn1.Primitive({
        idBlock: { tagClass: 3, tagNumber: 3 },
        valueHex: Uint8Array.of(0x03, 0x48).buffer,
      })
    );
    expect(parsedOf("2.5.29.28", schema)).toEqual({
      extensionType: "issuingDistributionPoint",
      distributionPoint: {
        fullName: [{ type: "uniformResourceIdentifier", value: "http://crl.example/full.crl" }],
      },
      onlyContainsUserCerts: true,
      onlyContainsCACerts: false,
      onlySomeReasons: ["keyCompromise", "superseded"],
      indirectCRL: true,
      onlyContainsAttributeCerts: false,
    });
  });

  it("policy constraints, mappings, inhibit anyPolicy and private key usage period decode", () => {
    expect(
      parsedOf(
        "2.5.29.36",
        new pkijs.PolicyConstraints({
          requireExplicitPolicy: 0,
          inhibitPolicyMapping: 2,
        }).toSchema()
      )
    ).toEqual({
      extensionType: "policyConstraints",
      requireExplicitPolicy: 0,
      inhibitPolicyMapping: 2,
    });
    expect(
      parsedOf(
        "2.5.29.33",
        new pkijs.PolicyMappings({
          mappings: [
            new pkijs.PolicyMapping({
              issuerDomainPolicy: "1.2.3.4",
              subjectDomainPolicy: "2.23.140.1.2.2",
            }),
          ],
        }).toSchema()
      )
    ).toEqual({
      extensionType: "policyMappings",
      mappings: [
        {
          issuerDomainPolicy: { oid: "1.2.3.4", name: null },
          subjectDomainPolicy: { oid: "2.23.140.1.2.2", name: "CA/Browser Forum OV" },
        },
      ],
    });
    expect(parsedOf("2.5.29.54", new asn1.Integer({ value: 1 }))).toEqual({
      extensionType: "inhibitAnyPolicy",
      skipCerts: 1,
    });
    const period = parsedOf(
      "2.5.29.16",
      new pkijs.PrivateKeyUsagePeriod({
        notBefore: new Date("2026-01-01T00:00:00Z"),
        notAfter: new Date("2027-01-01T00:00:00Z"),
      }).toSchema()
    );
    expect(period).toEqual({
      extensionType: "privateKeyUsagePeriod",
      notBefore: {
        iso: "2026-01-01T00:00:00.000Z",
        type: "generalizedTime",
        raw: "20260101000000Z",
      },
      notAfter: {
        iso: "2027-01-01T00:00:00.000Z",
        type: "generalizedTime",
        raw: "20270101000000Z",
      },
    });
  });

  it("CRL entry extensions decode certificate issuer, hold instruction and expired certs", () => {
    expect(
      parsedOf(
        "2.5.29.29",
        new pkijs.GeneralNames({
          names: [
            new pkijs.GeneralName({
              type: 4,
              value: new pkijs.RelativeDistinguishedNames({
                typesAndValues: [
                  new pkijs.AttributeTypeAndValue({
                    type: "2.5.4.3",
                    value: new asn1.Utf8String({ value: "Indirect, CA" }),
                  }),
                ],
              }),
            }),
          ],
        }).toSchema()
      )
    ).toEqual({
      extensionType: "certificateIssuer",
      names: [{ type: "directoryName", value: "CN=Indirect\\, CA" }],
    });
    expect(
      parsedOf("2.5.29.23", new asn1.ObjectIdentifier({ value: "1.2.840.10040.2.2" }))
    ).toEqual({
      extensionType: "holdInstructionCode",
      instruction: { oid: "1.2.840.10040.2.2", name: "holdInstructionCallIssuer" },
    });
    expect(
      parsedOf(
        "2.5.29.60",
        new asn1.GeneralizedTime({ valueDate: new Date("2020-06-01T00:00:00Z") })
      )
    ).toEqual({
      extensionType: "expiredCertsOnCRL",
      date: { iso: "2020-06-01T00:00:00.000Z", type: "generalizedTime", raw: "20200601000000Z" },
    });
  });

  it("alternative names decode UPN otherNames, directory names and registered IDs", () => {
    const otherName = contextSequence(0, [
      new asn1.ObjectIdentifier({ value: "1.3.6.1.4.1.311.20.2.3" }),
      contextSequence(0, [new asn1.Utf8String({ value: "user@ad.example" })]),
    ]);
    const registeredId = new pkijs.GeneralName({ type: 8, value: "1.2.3.4" }).toSchema();
    const san = new asn1.Sequence({
      value: [otherName, dns("host.example").toSchema(), registeredId],
    });
    const parsed = variant(parsedOf("2.5.29.17", san), "subjectAltName");
    expect(parsed.names[0]).toEqual({
      type: "otherName",
      value: "user@ad.example",
      typeOid: "1.3.6.1.4.1.311.20.2.3",
      typeName: "userPrincipalName",
      rawHex: "0C0F757365724061642E6578616D706C65",
    });
    expect(parsed.names[1]).toEqual({ type: "dNSName", value: "host.example" });
    expect(parsed.names[2]).toEqual({ type: "registeredID", value: "1.2.3.4" });
    const ian = parsedOf(
      "2.5.29.18",
      new pkijs.AltName({ altNames: [uri("https://ca.example")] }).toSchema()
    );
    expect(ian).toEqual({
      extensionType: "issuerAltName",
      names: [{ type: "uniformResourceIdentifier", value: "https://ca.example" }],
    });
  });

  it("certificate policies decode CPS URIs and user notices; distribution points decode reasons", () => {
    const policies = new pkijs.CertificatePolicies({
      certificatePolicies: [
        new pkijs.PolicyInformation({
          policyIdentifier: "2.23.140.1.2.1",
          policyQualifiers: [
            new pkijs.PolicyQualifierInfo({
              policyQualifierId: "1.3.6.1.5.5.7.2.1",
              qualifier: new asn1.IA5String({ value: "https://ca.example/cps" }),
            }),
            new pkijs.PolicyQualifierInfo({
              policyQualifierId: "1.3.6.1.5.5.7.2.2",
              qualifier: new asn1.Sequence({
                value: [
                  new asn1.Sequence({
                    value: [
                      new asn1.Utf8String({ value: "Example Org" }),
                      new asn1.Sequence({
                        value: [new asn1.Integer({ value: 1 }), new asn1.Integer({ value: 2 })],
                      }),
                    ],
                  }),
                  new asn1.Utf8String({ value: "Read the CPS" }),
                ],
              }),
            }),
          ],
        }),
      ],
    });
    const parsed = variant(parsedOf("2.5.29.32", policies.toSchema()), "certificatePolicies");
    expect(parsed.policies[0]?.policyIdentifier.name).toBe("CA/Browser Forum DV");
    expect(parsed.policies[0]?.policyQualifiers?.[0]?.cpsUri).toBe("https://ca.example/cps");
    expect(parsed.policies[0]?.policyQualifiers?.[1]?.userNotice).toEqual({
      organization: "Example Org",
      noticeNumbers: ["1", "2"],
      explicitText: "Read the CPS",
    });

    const cdp = new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [uri("http://crl.example/a.crl")],
          reasons: new asn1.BitString({ valueHex: Uint8Array.of(0x60).buffer, unusedBits: 5 }),
          cRLIssuer: [dns("crl-issuer.example")],
        }),
      ],
    });
    const points = variant(parsedOf("2.5.29.31", cdp.toSchema()), "cRLDistributionPoints");
    expect(points.distributionPoints[0]?.reasons).toEqual(["keyCompromise", "cACompromise"]);
    expect(points.distributionPoints[0]?.cRLIssuer).toEqual([
      { type: "dNSName", value: "crl-issuer.example" },
    ]);
  });

  it("TLS feature, OCSP no-check, Netscape and SIA extensions decode", () => {
    expect(
      parsedOf("1.3.6.1.5.5.7.1.24", new asn1.Sequence({ value: [new asn1.Integer({ value: 5 })] }))
    ).toEqual({ extensionType: "tlsFeature", features: [{ code: 5, name: "status_request" }] });
    expect(parsedOf("1.3.6.1.5.5.7.48.1.5", new asn1.Null())).toEqual({
      extensionType: "ocspNoCheck",
    });
    expect(
      parsedOf(
        "2.16.840.1.113730.1.1",
        new asn1.BitString({ valueHex: Uint8Array.of(0xa0).buffer, unusedBits: 5 })
      )
    ).toEqual({ extensionType: "netscapeCertType", flags: ["sslClient", "smime"] });
    expect(
      parsedOf("2.16.840.1.113730.1.13", new asn1.IA5String({ value: "Generated by test" }))
    ).toEqual({ extensionType: "netscapeComment", comment: "Generated by test" });
    const sia = parsedOf(
      "1.3.6.1.5.5.7.1.11",
      new pkijs.InfoAccess({
        accessDescriptions: [
          new pkijs.AccessDescription({
            accessMethod: "1.3.6.1.5.5.7.48.5",
            accessLocation: uri("http://repo.example"),
          }),
        ],
      }).toSchema()
    );
    expect(sia).toEqual({
      extensionType: "subjectInfoAccess",
      accessDescriptions: [
        {
          accessMethod: { oid: "1.3.6.1.5.5.7.48.5", name: "caRepository" },
          accessLocation: { type: "uniformResourceIdentifier", value: "http://repo.example" },
        },
      ],
    });
  });

  it("Microsoft template, previous hash, virtual base and NTDS security extensions decode", () => {
    expect(
      parsedOf(
        "1.3.6.1.4.1.311.21.7",
        new pkijs.CertificateTemplate({
          templateID: "1.3.6.1.4.1.311.21.8.1.2.3",
          templateMajorVersion: 100,
          templateMinorVersion: 4,
        }).toSchema()
      )
    ).toEqual({
      extensionType: "msCertificateTemplate",
      templateId: { oid: "1.3.6.1.4.1.311.21.8.1.2.3", name: null },
      majorVersion: 100,
      minorVersion: 4,
    });
    expect(
      parsedOf(
        "1.3.6.1.4.1.311.21.2",
        new asn1.OctetString({ valueHex: Uint8Array.of(1, 2, 3).buffer })
      )
    ).toEqual({ extensionType: "msPreviousCaCertificateHash", hash: "010203" });
    expect(parsedOf("1.3.6.1.4.1.311.21.3", new asn1.Integer({ value: 42 }))).toEqual({
      extensionType: "msCrlVirtualBase",
      number: "42",
    });
    const sid = new asn1.Sequence({
      value: [
        contextSequence(0, [
          new asn1.ObjectIdentifier({ value: "1.3.6.1.4.1.311.25.2.1" }),
          contextSequence(0, [
            new asn1.OctetString({
              valueHex: new TextEncoder().encode("S-1-5-21-1-2-3-1105").buffer,
            }),
          ]),
        ]),
      ],
    });
    expect(parsedOf("1.3.6.1.4.1.311.25.2", sid)).toEqual({
      extensionType: "msNtdsCaSecurity",
      sid: "S-1-5-21-1-2-3-1105",
    });
    const appPolicies = variant(
      parsedOf(
        "1.3.6.1.4.1.311.21.10",
        new pkijs.CertificatePolicies({
          certificatePolicies: [
            new pkijs.PolicyInformation({ policyIdentifier: "1.3.6.1.5.5.7.3.1" }),
          ],
        }).toSchema()
      ),
      "msApplicationPolicies"
    );
    expect(appPolicies.policies[0]?.policyIdentifier.name).toBe("serverAuth");
  });

  it("unsupported and malformed extensions carry a generic ASN.1 dump", () => {
    const unsupported = buildExtension(
      extension(
        "1.2.3.4.5",
        new asn1.Sequence({
          value: [
            new asn1.ObjectIdentifier({ value: "2.5.29.20" }),
            new asn1.Utf8String({ value: "hello" }),
            new asn1.Integer({ value: 7 }),
          ],
        })
      )
    );
    expect(unsupported.parseStatus).toBe("unsupported");
    expect(unsupported.asn1).toEqual([
      { depth: 0, tag: "SEQUENCE", length: 15 },
      { depth: 1, tag: "OBJECT IDENTIFIER", length: 3, value: "2.5.29.20 (CRL Number)" },
      { depth: 1, tag: "UTF8String", length: 5, value: "hello" },
      { depth: 1, tag: "INTEGER", length: 1, value: "7" },
    ]);
    const malformed = buildExtension(extension("2.5.29.19", new asn1.Null()));
    expect(malformed.parseStatus).toBe("error");
    expect(malformed.asn1).toEqual([{ depth: 0, tag: "NULL", length: 0 }]);
    expect(
      buildExtension(
        new pkijs.Extension({ extnID: "1.2.3", extnValue: Uint8Array.of(0xff).buffer })
      ).asn1
    ).toBeUndefined();
    expect(dumpAsn1(Uint8Array.of(0xff, 0xff))).toBeUndefined();
    const parsed = buildExtension(extension("2.5.29.54", new asn1.Integer({ value: 0 })));
    expect(parsed.asn1).toBeUndefined();
  });

  it("algorithm identifiers decode NULL, named curve and RSASSA-PSS parameters", () => {
    expect(
      buildAlgorithmIdentifier("1.2.840.113549.1.1.11", new asn1.Null(), SIGNATURE_ALG_NAMES)
    ).toEqual({
      algorithm: { oid: "1.2.840.113549.1.1.11", name: "sha256WithRSAEncryption" },
      parameters: { rawHex: "0500", parsed: { type: "null" } },
    });
    expect(
      buildAlgorithmIdentifier(
        "1.2.840.10045.2.1",
        new asn1.ObjectIdentifier({ value: "1.2.840.10045.3.1.7" })
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
    const identifier = buildAlgorithmIdentifier(
      "1.2.840.113549.1.1.10",
      reparsed,
      SIGNATURE_ALG_NAMES
    );
    expect(identifier.algorithm.name).toBe("RSASSA-PSS");
    expect(identifier.parameters?.parsed).toEqual({
      type: "rsassaPss",
      hashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
      maskGenAlgorithm: { oid: "1.2.840.113549.1.1.8", name: "MGF1" },
      maskGenHashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
      saltLength: 32,
      trailerField: 1,
    });
    expect(buildAlgorithmIdentifier("1.2.3", "not a block").parameters).toBeUndefined();
  });

  it("distinguished names report encodings, escape RFC 4514 specials and keep raw non-strings", () => {
    const attribute = (type: string, value: pkijs.AttributeTypeAndValue["value"]) =>
      new pkijs.AttributeTypeAndValue({ type, value }).toSchema();
    const name = new pkijs.RelativeDistinguishedNames({
      schema: asn1.fromBER(
        new asn1.Sequence({
          value: [
            new asn1.Set({
              value: [attribute("2.5.4.6", new asn1.PrintableString({ value: "CA" }))],
            }),
            new asn1.Set({
              value: [
                attribute("0.9.2342.19200300.100.1.25", new asn1.IA5String({ value: "example" })),
                attribute("2.5.4.10", new asn1.BmpString({ value: "Acme, Inc. " })),
              ],
            }),
            new asn1.Set({
              value: [
                attribute(
                  "2.5.4.5",
                  // Deliberately not a string type; PKIjs typing only covers string values.
                  new asn1.Integer({ value: 7 }) as unknown as pkijs.AttributeTypeAndValue["value"]
                ),
              ],
            }),
            new asn1.Set({
              value: [attribute("2.5.4.3", new asn1.TeletexString({ value: "#1 <Root>" }))],
            }),
          ],
        }).toBER(false)
      ).result,
    });
    const built = buildName(name);
    expect(built.rdnSequence.flatMap((rdn) => rdn.attributes.map((a) => a.value.encoding))).toEqual(
      ["printableString", "ia5String", "bmpString", "unknown", "teletexString"]
    );
    expect(built.rdnSequence[2]?.attributes[0]?.value.string).toBeNull();
    expect(built.rdnSequence[2]?.attributes[0]?.value.rawHex).toBe("020107");
    expect(built.rfc4514).toBe(
      "CN=\\#1 \\<Root\\>,serialNumber=#020107,DC=example+O=Acme\\, Inc.\\ ,C=CA"
    );
    expect(built.commonName).toBe("#1 <Root>");
    expect(escapeRdnValue(" lead")).toBe("\\ lead");
    expect(escapeRdnValue("a\\b;c")).toBe("a\\\\b\\;c");
  });
});

describe("decoders the old tests did not reach", () => {
  /** The revoked entries of a fixture CRL by serial (uppercase hex, as the manifest has it). */
  function revokedEntries(file: string): Map<string, RevokedCertificate> {
    const entries = buildTBSCertList(parseCRL(fixture(file))).revokedCertificates.items;
    return new Map(entries.map((entry) => [entry.userCertificate.hex, entry]));
  }

  function entryExtensions(entry: RevokedCertificate | undefined): Extension[] {
    const items = entry?.crlEntryExtensions?.items ?? [];
    expect(items.map((item) => item.parseStatus)).toEqual(items.map(() => "parsed"));
    return items;
  }

  it("decodes cRLReason and invalidityDate of the entries of crls/issuing-ca-1/full-03", () => {
    const entries = revokedEntries("crls/issuing-ca-1/full-03.der");
    expect(entries.size).toBe(crlEntry("crls/issuing-ca-1/full-03.der").revoked);

    const revoked = entryExtensions(entries.get(certificateEntry("leaf-revoked").serial));
    expect(byOid(revoked, "2.5.29.21").parsed).toEqual({
      extensionType: "cRLReason",
      code: 1,
      name: "keyCompromise",
    });
    // The invalidity date is not in the manifest: compare with an independent decoding of the
    // extension value. RFC 5280 §5.3.2 requires a GeneralizedTime.
    const invalidity = byOid(revoked, "2.5.29.24");
    const { type, raw, date } = readStrictTime(
      asn1.fromBER(fromHex(invalidity.extnValue.hex)).result
    );
    expect(type).toBe("generalizedTime");
    expect(invalidity.parsed).toEqual({
      extensionType: "invalidityDate",
      date: { iso: date.toISOString(), type, raw },
    });

    const superseded = entryExtensions(entries.get(certificateEntry("leaf-superseded").serial));
    expect(superseded.map((item) => item.parsed)).toEqual([
      { extensionType: "cRLReason", code: 4, name: "superseded" },
    ]);
  });

  it("decodes certificateHold and holdInstructionReject of crls/issuing-ca-2/full-01", () => {
    const entries = revokedEntries("crls/issuing-ca-2/full-01.der");
    const hold = entryExtensions(entries.get(certificateEntry("leaf-hold").serial));
    expect(hold.map((item) => item.parsed)).toEqual([
      { extensionType: "cRLReason", code: 6, name: "certificateHold" },
      {
        extensionType: "holdInstructionCode",
        instruction: { oid: "1.2.840.10040.2.3", name: "holdInstructionReject" },
      },
    ]);
  });

  it("decodes the Extended Key Usage of certs/leaf-full", async () => {
    const tbs = await buildTBSCertificate(certificate("leaf-full"));
    // ext_leaf_full: extendedKeyUsage = serverAuth, clientAuth.
    expect(byOid(tbs.extensions?.items, "2.5.29.37").parsed).toEqual({
      extensionType: "extendedKeyUsage",
      purposes: [
        { oid: "1.3.6.1.5.5.7.3.1", name: "serverAuth" },
        { oid: "1.3.6.1.5.5.7.3.2", name: "clientAuth" },
      ],
    });
  });

  it("decodes QC Statements with and without statementInfo", () => {
    const qcType = new asn1.Sequence({
      value: [new asn1.ObjectIdentifier({ value: "0.4.0.1862.1.6.1" })],
    });
    // PKIjs 3.4.1 types the QCStatements constructor with QCStatement's parameters.
    const statements = new pkijs.QCStatements();
    statements.values = [
      new pkijs.QCStatement({ id: "0.4.0.1862.1.1" }),
      new pkijs.QCStatement({ id: "0.4.0.1862.1.6", type: qcType }),
    ];
    expect(parsedOf("1.3.6.1.5.5.7.1.3", statements.toSchema())).toEqual({
      extensionType: "qcStatements",
      statements: [
        { statementId: { oid: "0.4.0.1862.1.1", name: "QcCompliance" }, rawHex: "" },
        {
          statementId: { oid: "0.4.0.1862.1.6", name: "QcType" },
          rawHex: toHex(qcType.toBER(false)).toUpperCase(),
        },
      ],
    });
  });

  it("decodes a Signed Certificate Timestamp List", () => {
    const logId = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02);
    const timestamp = new Date("2026-01-02T03:04:05.678Z");
    // RFC 6962 §3.2–3.3, written by hand: PKIjs's SignedCertificateTimestampList encoder pads the
    // list with zero octets, which its own decoder then rejects.
    const ms = BigInt(timestamp.getTime());
    const sct = [
      0, // v1
      ...logId,
      ...Array.from({ length: 8 }, (_, index) => Number((ms >> BigInt(56 - 8 * index)) & 0xffn)),
      ...[0, 0], // no extensions
      ...[4, 3], // sha256, ecdsa
      ...[signature.length >> 8, signature.length & 0xff, ...signature],
    ];
    const list = [sct.length >> 8, sct.length & 0xff, ...sct];
    const value = new asn1.OctetString({
      valueHex: Uint8Array.from([list.length >> 8, list.length & 0xff, ...list]).buffer,
    });
    expect(parsedOf("1.3.6.1.4.1.11129.2.4.2", value)).toEqual({
      extensionType: "signedCertificateTimestampList",
      timestamps: [
        {
          version: 0,
          logId: toHex(logId).toUpperCase(),
          timestamp: timestamp.toISOString(),
          hashAlgorithm: "sha256",
          signatureAlgorithm: "ecdsa",
          signature: toHex(signature).toUpperCase(),
        },
      ],
    });
  });

  // PKIjs does not fail on truncated TLS data: it yields SCTs without a version, with an empty
  // logID and a timestamp of 0 (1970). Such a list is an error, not a parsed list of invented SCTs.
  it("reports a truncated or malformed SCT list as an error with the dump", () => {
    const logId = Uint8Array.from({ length: 32 }, (_, index) => index);
    const sct = [0, ...logId, ...new Array<number>(8).fill(0), 0, 0, 4, 3, 0, 2, 0x30, 0x00];
    const list = (...scts: number[][]) => {
      const body = scts.flatMap((each) => [each.length >> 8, each.length & 0xff, ...each]);
      return new asn1.OctetString({
        valueHex: Uint8Array.from([body.length >> 8, body.length & 0xff, ...body]).buffer,
      });
    };
    expect(parsedOf("1.3.6.1.4.1.11129.2.4.2", list(sct))).toMatchObject({
      timestamps: [{ version: 0, signature: "3000" }],
    });
    const malformed = [
      // The probe of the slice 5a review: extnValue 04 04 00 02 09 09.
      new asn1.OctetString({ valueHex: Uint8Array.of(0, 2, 9, 9).buffer }),
      // An empty SCT behind a valid one.
      list(sct, []),
      // Another version: PKIjs reads nothing after the version octet.
      list([1]),
      // An empty signature.
      list([...sct.slice(0, -4), 0, 0]),
    ];
    const results = malformed.map((value) =>
      buildExtension(extension("1.3.6.1.4.1.11129.2.4.2", value))
    );
    expect(results.map(({ parseStatus, parsed }) => ({ parseStatus, parsed }))).toEqual(
      malformed.map(() => ({ parseStatus: "error", parsed: undefined }))
    );
    expect(results.map((result) => result.asn1)).toEqual(
      malformed.map((value) => [
        {
          depth: 0,
          tag: "OCTET STRING",
          length: value.valueBlock.valueHexView.length,
          value: toHex(value.valueBlock.valueHexView).toUpperCase(),
        },
      ])
    );
  });

  it("decodes Subject Directory Attributes", () => {
    const attributes = new pkijs.SubjectDirectoryAttributes({
      attributes: [
        // dateOfBirth and countryOfCitizenship (RFC 3739 §3.2.2).
        new pkijs.Attribute({
          type: "1.3.6.1.5.5.7.9.1",
          values: [new asn1.GeneralizedTime({ valueDate: new Date("1980-01-01T12:00:00Z") })],
        }),
        new pkijs.Attribute({
          type: "1.3.6.1.5.5.7.9.4",
          values: [
            new asn1.PrintableString({ value: "CA" }),
            new asn1.PrintableString({ value: "US" }),
          ],
        }),
        new pkijs.Attribute({
          type: "2.5.4.12",
          values: [new asn1.Utf8String({ value: "Operator" })],
        }),
      ],
    });
    expect(parsedOf("2.5.29.9", attributes.toSchema())).toEqual({
      extensionType: "subjectDirectoryAttributes",
      attributes: [
        { type: { oid: "1.3.6.1.5.5.7.9.1", name: null }, values: ["1980-01-01T12:00:00.000Z"] },
        { type: { oid: "1.3.6.1.5.5.7.9.4", name: null }, values: ["CA", "US"] },
        { type: { oid: "2.5.4.12", name: "title" }, values: ["Operator"] },
      ],
    });
  });
});
