import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { formatGeneralizedTime, readStrictTime } from "../../../src/core/pki/asn1.ts";
import { toHex } from "../../../src/core/digest.ts";
import { parseCertificate, parseCRL } from "../../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../../src/core/summary/certificate.ts";
import { buildTBSCertList } from "../../../src/core/summary/crl.ts";
import { buildExtension } from "../../../src/core/summary/extensions.ts";
import { buildSignatureValue } from "../../../src/core/summary/primitives.ts";
import type { Extension, ParsedExtensionValue } from "../../../src/core/summary/types.ts";
import { fixture } from "../../fixtures/pki.ts";
import { cert, crlEntry } from "../../helpers/catalog.ts";
import { extension } from "../../helpers/pki.ts";

// The extension decoders of the X.509 detail: the AD CS style fixtures, then one value built in
// the test for each decoder the fixtures do not reach.

const certificate = (name: string) => parseCertificate(fixture(cert(name).der));

/** The Time projection of a manifest time (ISO 8601 UTC) that the fixture encodes as UTCTime. */
function utcTime(iso: string) {
  const date = new Date(iso);
  return { iso: date.toISOString(), type: "utcTime", raw: formatGeneralizedTime(date).slice(2) };
}

function byOid<T extends { extnID: { oid: string } }>(items: T[] | undefined, oid: string): T {
  const found = items?.find((item) => item.extnID.oid === oid);
  expect(found, `extension ${oid} present`).toBeDefined();
  return found!;
}

/** The parsed values of `items`, after asserting that every one parsed. */
function parsedOf(items: Extension[] | undefined): (ParsedExtensionValue | undefined)[] {
  expect(items?.map((item) => item.parseStatus)).toEqual(items?.map(() => "parsed"));
  return items?.map((item) => item.parsed) ?? [];
}

describe("the fixtures", () => {
  it("decodes every extension of certs/issuing-ca-1, the Microsoft ones included", async () => {
    const entry = cert("issuing-ca-1");
    const tbs = await buildTBSCertificate(certificate("issuing-ca-1"));
    const items = tbs.extensions?.items ?? [];
    // The AD CS SubCA template shape, in order; basicConstraints and keyUsage are critical.
    expect(parsedOf(items).map((parsed) => parsed?.extensionType)).toEqual([
      "subjectKeyIdentifier",
      "authorityKeyIdentifier",
      "basicConstraints",
      "keyUsage",
      "authorityInfoAccess",
      "cRLDistributionPoints",
      "msCaVersion",
      "msCertificateTemplateName",
    ]);
    expect(tbs.extensions?.critical).toBe(2);
    expect(byOid(items, "1.3.6.1.4.1.311.21.1")).toMatchObject({
      extnID: { name: "CA Version" },
      parsed: { extensionType: "msCaVersion", certificateIndex: 0, keyIndex: 0 },
    });
    expect(byOid(items, "1.3.6.1.4.1.311.20.2").parsed).toEqual({
      extensionType: "msCertificateTemplateName",
      name: "SubCA",
    });
    expect(tbs.subject.rfc4514).toBe("CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US");
    expect(tbs.issuer.rfc4514).toBe("CN=Example Root CA (ECC P-384),O=Example PKI,C=US");
    expect(tbs.subject.rdnSequence[0]?.attributes[0]?.value.encoding).toBe("printableString");
    expect(tbs.validity).toEqual({
      notBefore: utcTime(entry.notBefore),
      notAfter: utcTime(entry.notAfter),
    });
    // Signed by root-ca: ECDSA, whose AlgorithmIdentifier has no parameters (RFC 5758 §3.2).
    expect(tbs.signature).toEqual({
      algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
    });
  });

  it("exposes the named curve of certs/root-ca and its ECDSA (r, s) pair", async () => {
    const root = certificate("root-ca");
    expect((await buildTBSCertificate(root)).subjectPublicKeyInfo.algorithm.parameters).toEqual({
      rawHex: expect.any(String) as unknown,
      parsed: { type: "objectIdentifier", oid: { oid: "1.3.132.0.34", name: "P-384" } },
    });
    const signature = (of: pkijs.Certificate) =>
      buildSignatureValue(of.signatureValue, of.signatureAlgorithm.algorithmId).parsed;
    const parsed = signature(root);
    expect(parsed?.type).toBe("ecdsa");
    // r and s are at most 48 octets (P-384), unsigned, without the INTEGER's sign octet.
    for (const value of [parsed?.r, parsed?.s]) {
      expect(value).toMatch(/^(?!00)[0-9A-F]{1,96}$/);
    }
    // leaf-full is signed by issuing-ca-1 (RSA): no (r, s) pair.
    expect(signature(certificate("leaf-full"))).toBeUndefined();
  });

  it("decodes the extensions of crls/issuing-ca-1/full-adcs and delta-adcs", () => {
    const itemsOf = (file: string) =>
      buildTBSCertList(parseCRL(fixture(file))).crlExtensions?.items;
    const full = crlEntry("crls/issuing-ca-1/full-adcs.der");
    const items = itemsOf(full.file);
    // In the order of the file: openssl ca appends the CRL Number last.
    expect(parsedOf(items).map((parsed) => parsed?.extensionType)).toEqual([
      "authorityKeyIdentifier",
      "msCaVersion",
      "msCrlNextPublish",
      "freshestCRL",
      "msCrlSelfCdp",
      "cRLNumber",
    ]);
    expect(byOid(items, "1.3.6.1.4.1.311.21.4").parsed).toEqual({
      extensionType: "msCrlNextPublish",
      date: utcTime(full.nextPublish!),
    });
    expect(byOid(items, "2.5.29.20").parsed).toEqual({
      extensionType: "cRLNumber",
      number: full.crlNumber,
    });
    const delta = crlEntry("crls/issuing-ca-1/delta-adcs.der");
    expect(byOid(itemsOf(delta.file), "2.5.29.27")).toMatchObject({
      critical: true,
      parsed: { extensionType: "deltaCRLIndicator", baseCRLNumber: delta.baseCrlNumber },
    });
  });

  it("decodes the entry extensions of crls/issuing-ca-1/full-03 and crls/issuing-ca-2/full-01", () => {
    const entries = (file: string) =>
      new Map(
        buildTBSCertList(parseCRL(fixture(file))).revokedCertificates.items.map((entry) => [
          entry.userCertificate.hex,
          entry.crlEntryExtensions?.items,
        ])
      );
    const full03 = entries("crls/issuing-ca-1/full-03.der");
    const revoked = full03.get(cert("leaf-revoked").serial);
    // The invalidity date is not in the manifest: compare with an independent decoding.
    const invalidity = byOid(revoked, "2.5.29.24").extnValue.hex;
    const { date, raw } = readStrictTime(asn1.fromBER(Buffer.from(invalidity, "hex")).result);
    expect(parsedOf(revoked)).toEqual([
      { extensionType: "cRLReason", code: 1, name: "keyCompromise" },
      {
        extensionType: "invalidityDate",
        date: { iso: date.toISOString(), type: "generalizedTime", raw },
      },
    ]);
    expect(parsedOf(full03.get(cert("leaf-superseded").serial))).toEqual([
      { extensionType: "cRLReason", code: 4, name: "superseded" },
    ]);
    const hold = entries("crls/issuing-ca-2/full-01.der").get(cert("leaf-hold").serial);
    expect(parsedOf(hold)).toEqual([
      { extensionType: "cRLReason", code: 6, name: "certificateHold" },
      {
        extensionType: "holdInstructionCode",
        instruction: { oid: "1.2.840.10040.2.3", name: "holdInstructionReject" },
      },
    ]);
  });

  it("decodes the Extended Key Usage of certs/leaf-full", async () => {
    const tbs = await buildTBSCertificate(certificate("leaf-full"));
    expect(byOid(tbs.extensions?.items, "2.5.29.37").parsed).toEqual({
      extensionType: "extendedKeyUsage",
      purposes: [
        { oid: "1.3.6.1.5.5.7.3.1", name: "serverAuth" },
        { oid: "1.3.6.1.5.5.7.3.2", name: "clientAuth" },
      ],
    });
  });
});

// Builders of the values below, and of what they decode to.
const seq = (...value: asn1.BaseBlock[]) => new asn1.Sequence({ value });
const utf8 = (value: string) => new asn1.Utf8String({ value });
const int = (value: number) => new asn1.Integer({ value });
const objectId = (value: string) => new asn1.ObjectIdentifier({ value });
const octets = (bytes: ArrayLike<number>) =>
  new asn1.OctetString({ valueHex: Uint8Array.from(bytes).buffer });
const bits = (byte: number, unusedBits: number) =>
  new asn1.BitString({ valueHex: Uint8Array.of(byte).buffer, unusedBits });
const context = (tagNumber: number, ...value: asn1.BaseBlock[]) =>
  new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value });
const zeros = (count: number) => new Array<number>(count).fill(0);
const uri = (value: string) => new pkijs.GeneralName({ type: 6, value });
const ip = (...bytes: number[]) => new pkijs.GeneralName({ type: 7, value: octets(bytes) });
/** A GeneralName inside a hand-built SEQUENCE (PKIjs types toSchema() as a union). */
const block = (name: pkijs.GeneralName) => name.toSchema() as asn1.BaseBlock;
const URI = (value: string) => ({ type: "uniformResourceIdentifier", value });
const named = (oid: string, name: string | null = null) => ({ oid, name });
const generalized = (iso: string) => ({
  iso: new Date(iso).toISOString(),
  type: "generalizedTime",
  raw: formatGeneralizedTime(new Date(iso)),
});

const SCT_LOG_ID = Uint8Array.from({ length: 32 }, (_, index) => index);
const SCT_SIGNATURE = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02];
const SCT_TIME = new Date("2026-01-02T03:04:05.678Z");

/** A list of one v1 SCT (RFC 6962 §3.2–3.3) by hand: PKIjs's encoder pads it with zero octets. */
function sctList(): asn1.OctetString {
  const ms = BigInt(SCT_TIME.getTime());
  const time = Array.from({ length: 8 }, (_, at) => Number((ms >> BigInt(56 - 8 * at)) & 0xffn));
  // v1, log id, timestamp, no extensions, sha256 / ecdsa, signature.
  const sct = [0, ...SCT_LOG_ID, ...time, 0, 0, 4, 3, 0, SCT_SIGNATURE.length, ...SCT_SIGNATURE];
  return octets([0, sct.length + 2, 0, sct.length, ...sct]);
}

const qcType = seq(objectId("0.4.0.1862.1.6.1"));
// PKIjs types the QCStatements constructor with QCStatement's parameters.
const qcStatements = new pkijs.QCStatements();
qcStatements.values = [
  new pkijs.QCStatement({ id: "0.4.0.1862.1.1" }),
  new pkijs.QCStatement({ id: "0.4.0.1862.1.6", type: qcType }),
];

const policies = (policyIdentifier: string, policyQualifiers?: pkijs.PolicyQualifierInfo[]) =>
  new pkijs.CertificatePolicies({
    certificatePolicies: [
      new pkijs.PolicyInformation({
        policyIdentifier,
        ...(policyQualifiers === undefined ? {} : { policyQualifiers }),
      }),
    ],
  }).toSchema();

const DECODED: [type: string, oid: string, value: { toBER(): ArrayBuffer }, parsed: object][] = [
  [
    "authorityKeyIdentifier",
    "2.5.29.35",
    new pkijs.AuthorityKeyIdentifier({
      keyIdentifier: octets([0xab, 0xcd]),
      authorityCertIssuer: [uri("https://ca.example/issuer")],
      authorityCertSerialNumber: int(17),
    }).toSchema(),
    {
      keyIdentifier: "ABCD",
      authorityCertSerialNumber: "11",
      authorityCertIssuer: [URI("https://ca.example/issuer")],
    },
  ],
  [
    // Read from the contents octets: asn1js's valueDec is 0 from four contents octets on.
    "basicConstraints",
    "2.5.29.19",
    new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 2 ** 40 }).toSchema(),
    { cA: true, pathLenConstraint: 2 ** 40 },
  ],
  [
    "subjectAltName",
    "2.5.29.17",
    seq(
      context(0, objectId("1.3.6.1.4.1.311.20.2.3"), context(0, utf8("user@ad.example"))),
      block(new pkijs.GeneralName({ type: 8, value: "1.2.3.4" })),
      context(4, seq(new asn1.Set({ value: [seq(objectId("2.5.4.3"), utf8("Indirect, CA"))] }))),
      block(ip(192, 0, 2, 1)),
      block(ip(0x20, 1, 0x0d, 0xb8, ...zeros(11), 1))
    ),
    {
      names: [
        {
          type: "otherName",
          value: "user@ad.example",
          typeOid: "1.3.6.1.4.1.311.20.2.3",
          typeName: "userPrincipalName",
          rawHex: "0C0F757365724061642E6578616D706C65",
        },
        { type: "registeredID", value: "1.2.3.4" },
        { type: "directoryName", value: "CN=Indirect\\, CA" },
        { type: "iPAddress", value: "192.0.2.1" },
        { type: "iPAddress", value: "2001:db8::1" },
      ],
    },
  ],
  [
    "issuerAltName",
    "2.5.29.18",
    new pkijs.AltName({ altNames: [uri("https://ca.example")] }).toSchema(),
    { names: [URI("https://ca.example")] },
  ],
  [
    "nameConstraints",
    "2.5.29.30",
    new pkijs.NameConstraints({
      permittedSubtrees: [
        new pkijs.GeneralSubtree({ base: ip(192, 0, 2, 0, 255, 255, 255, 0) }),
        new pkijs.GeneralSubtree({
          base: ip(0x20, 1, 0x0d, 0xb8, ...zeros(12), 255, 255, 255, 255, ...zeros(12)),
        }),
      ],
      excludedSubtrees: [
        new pkijs.GeneralSubtree({
          base: new pkijs.GeneralName({ type: 1, value: "nobody@example.com" }),
          minimum: 1,
          maximum: 3,
        }),
      ],
    }).toSchema(),
    {
      permittedSubtrees: [
        { base: { type: "iPAddress", value: "192.0.2.0/24" }, minimum: 0 },
        { base: { type: "iPAddress", value: "2001:db8::/32" }, minimum: 0 },
      ],
      excludedSubtrees: [
        { base: { type: "rfc822Name", value: "nobody@example.com" }, minimum: 1, maximum: 3 },
      ],
    },
  ],
  [
    "issuingDistributionPoint",
    "2.5.29.28",
    new pkijs.IssuingDistributionPoint({
      distributionPoint: [uri("http://crl.example/full.crl")],
    }).toSchema(),
    {
      distributionPoint: { fullName: [URI("http://crl.example/full.crl")] },
      onlyContainsUserCerts: false,
      onlyContainsCACerts: false,
      indirectCRL: false,
      onlyContainsAttributeCerts: false,
    },
  ],
  [
    "policyConstraints",
    "2.5.29.36",
    new pkijs.PolicyConstraints({ requireExplicitPolicy: 0, inhibitPolicyMapping: 2 }).toSchema(),
    { requireExplicitPolicy: 0, inhibitPolicyMapping: 2 },
  ],
  [
    "policyMappings",
    "2.5.29.33",
    seq(seq(objectId("1.2.3.4"), objectId("2.23.140.1.2.2"))),
    {
      mappings: [
        {
          issuerDomainPolicy: named("1.2.3.4"),
          subjectDomainPolicy: named("2.23.140.1.2.2", "CA/Browser Forum OV"),
        },
      ],
    },
  ],
  ["inhibitAnyPolicy", "2.5.29.54", int(1), { skipCerts: 1 }],
  [
    "privateKeyUsagePeriod",
    "2.5.29.16",
    new pkijs.PrivateKeyUsagePeriod({
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2027-01-01T00:00:00Z"),
    }).toSchema(),
    {
      notBefore: generalized("2026-01-01T00:00:00Z"),
      notAfter: generalized("2027-01-01T00:00:00Z"),
    },
  ],
  [
    "certificateIssuer",
    "2.5.29.29",
    new pkijs.GeneralNames({ names: [uri("https://other.example")] }).toSchema(),
    { names: [URI("https://other.example")] },
  ],
  [
    "expiredCertsOnCRL",
    "2.5.29.60",
    new asn1.GeneralizedTime({ valueDate: new Date("2020-06-01T00:00:00Z") }),
    { date: generalized("2020-06-01T00:00:00Z") },
  ],
  [
    "certificatePolicies",
    "2.5.29.32",
    policies("2.23.140.1.2.1", [
      new pkijs.PolicyQualifierInfo({
        policyQualifierId: "1.3.6.1.5.5.7.2.1",
        qualifier: new asn1.IA5String({ value: "https://ca.example/cps" }),
      }),
      new pkijs.PolicyQualifierInfo({
        policyQualifierId: "1.3.6.1.5.5.7.2.2",
        qualifier: seq(seq(utf8("Example Org"), seq(int(1), int(2))), utf8("Read the CPS")),
      }),
    ]),
    {
      policies: [
        {
          policyIdentifier: named("2.23.140.1.2.1", "CA/Browser Forum DV"),
          policyQualifiers: [
            {
              qualifierId: named("1.3.6.1.5.5.7.2.1", "cps"),
              rawHex: expect.any(String) as unknown,
              cpsUri: "https://ca.example/cps",
            },
            {
              qualifierId: named("1.3.6.1.5.5.7.2.2", "userNotice"),
              rawHex: expect.any(String) as unknown,
              userNotice: {
                organization: "Example Org",
                noticeNumbers: ["1", "2"],
                explicitText: "Read the CPS",
              },
            },
          ],
        },
      ],
    },
  ],
  [
    "msApplicationPolicies",
    "1.3.6.1.4.1.311.21.10",
    policies("1.3.6.1.5.5.7.3.1"),
    { policies: [{ policyIdentifier: named("1.3.6.1.5.5.7.3.1", "serverAuth") }] },
  ],
  [
    "cRLDistributionPoints",
    "2.5.29.31",
    new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [uri("http://crl.example/a.crl")],
          reasons: bits(0x60, 5),
          cRLIssuer: [new pkijs.GeneralName({ type: 2, value: "crl-issuer.example" })],
        }),
      ],
    }).toSchema(),
    {
      distributionPoints: [
        {
          distributionPoint: { fullName: [URI("http://crl.example/a.crl")] },
          reasons: ["keyCompromise", "cACompromise"],
          cRLIssuer: [{ type: "dNSName", value: "crl-issuer.example" }],
        },
      ],
    },
  ],
  [
    "subjectInfoAccess",
    "1.3.6.1.5.5.7.1.11",
    seq(seq(objectId("1.3.6.1.5.5.7.48.5"), block(uri("http://repo.example")))),
    {
      accessDescriptions: [
        {
          accessMethod: named("1.3.6.1.5.5.7.48.5", "caRepository"),
          accessLocation: URI("http://repo.example"),
        },
      ],
    },
  ],
  [
    "tlsFeature",
    "1.3.6.1.5.5.7.1.24",
    seq(int(5)),
    { features: [{ code: 5, name: "status_request" }] },
  ],
  ["ocspNoCheck", "1.3.6.1.5.5.7.48.1.5", new asn1.Null(), {}],
  ["netscapeCertType", "2.16.840.1.113730.1.1", bits(0xa0, 5), { flags: ["sslClient", "smime"] }],
  [
    "netscapeComment",
    "2.16.840.1.113730.1.13",
    new asn1.IA5String({ value: "Generated by test" }),
    { comment: "Generated by test" },
  ],
  [
    "qcStatements",
    "1.3.6.1.5.5.7.1.3",
    qcStatements.toSchema(),
    {
      statements: [
        { statementId: named("0.4.0.1862.1.1", "QcCompliance"), rawHex: "" },
        {
          statementId: named("0.4.0.1862.1.6", "QcType"),
          rawHex: toHex(qcType.toBER(false)).toUpperCase(),
        },
      ],
    },
  ],
  [
    "signedCertificateTimestampList",
    "1.3.6.1.4.1.11129.2.4.2",
    sctList(),
    {
      timestamps: [
        {
          version: 0,
          logId: toHex(SCT_LOG_ID).toUpperCase(),
          timestamp: SCT_TIME.toISOString(),
          hashAlgorithm: "sha256",
          signatureAlgorithm: "ecdsa",
          signature: toHex(Uint8Array.from(SCT_SIGNATURE)).toUpperCase(),
        },
      ],
    },
  ],
  [
    // dateOfBirth and countryOfCitizenship (RFC 3739 §3.2.2), and a title.
    "subjectDirectoryAttributes",
    "2.5.29.9",
    new pkijs.SubjectDirectoryAttributes({
      attributes: [
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
        new pkijs.Attribute({ type: "2.5.4.12", values: [utf8("Operator")] }),
      ],
    }).toSchema(),
    {
      attributes: [
        { type: named("1.3.6.1.5.5.7.9.1"), values: ["1980-01-01T12:00:00.000Z"] },
        { type: named("1.3.6.1.5.5.7.9.4"), values: ["CA", "US"] },
        { type: named("2.5.4.12", "title"), values: ["Operator"] },
      ],
    },
  ],
  [
    "msCertificateTemplate",
    "1.3.6.1.4.1.311.21.7",
    seq(objectId("1.3.6.1.4.1.311.21.8.1.2.3"), int(100), int(4)),
    { templateId: named("1.3.6.1.4.1.311.21.8.1.2.3"), majorVersion: 100, minorVersion: 4 },
  ],
  ["msPreviousCaCertificateHash", "1.3.6.1.4.1.311.21.2", octets([1, 2, 3]), { hash: "010203" }],
  ["msCrlVirtualBase", "1.3.6.1.4.1.311.21.3", int(42), { number: "42" }],
  [
    "msNtdsCaSecurity",
    "1.3.6.1.4.1.311.25.2",
    seq(
      context(
        0,
        objectId("1.3.6.1.4.1.311.25.2.1"),
        context(0, octets(new TextEncoder().encode("S-1-5-21-1-2-3-1105")))
      )
    ),
    { sid: "S-1-5-21-1-2-3-1105" },
  ],
];

describe("decoders on values built in the test", () => {
  it.each(DECODED)("decodes %s (%s)", (extensionType, oid, value, parsed) => {
    const result = buildExtension(extension(oid, value));
    expect([result.parseStatus, result.parsed]).toEqual(["parsed", { extensionType, ...parsed }]);
    // A parsed extension needs no dump.
    expect(result.asn1).toBeUndefined();
  });

  it("gives unsupported and malformed extensions a generic ASN.1 dump", () => {
    const unsupported = buildExtension(
      extension(
        "1.2.3.4.5",
        seq(
          objectId("2.5.29.20"),
          utf8("hello"),
          // Exact: asn1js's valueDec is 0 from four contents octets on.
          asn1.Integer.fromBigInt(2n ** 100n + 123n),
          new asn1.Enumerated({ value: 2 ** 31 })
        )
      )
    );
    expect(unsupported.parseStatus).toBe("unsupported");
    expect(unsupported.asn1).toEqual([
      { depth: 0, tag: "SEQUENCE", length: 34 },
      { depth: 1, tag: "OBJECT IDENTIFIER", length: 3, value: "2.5.29.20 (CRL Number)" },
      { depth: 1, tag: "UTF8String", length: 5, value: "hello" },
      { depth: 1, tag: "INTEGER", length: 13, value: "1267650600228229401496703205499" },
      { depth: 1, tag: "ENUMERATED", length: 5, value: "2147483648" },
    ]);
    const malformed = buildExtension(extension("2.5.29.19", new asn1.Null()));
    expect(malformed).toMatchObject({ parseStatus: "error", extnValue: { hex: "0500" } });
    expect(malformed.asn1).toEqual([{ depth: 0, tag: "NULL", length: 0 }]);
    const undecodable = buildExtension(
      new pkijs.Extension({ extnID: "1.2.3", extnValue: Uint8Array.of(0xff).buffer })
    );
    expect(undecodable.asn1).toBeUndefined();
  });

  it.each([
    // PKIjs yields an SCT of 1970 with an empty log id from truncated TLS data.
    ["a truncated SCT list", "1.3.6.1.4.1.11129.2.4.2", octets([0, 2, 9, 9])],
    [
      "a pathLenConstraint beyond Number.MAX_SAFE_INTEGER",
      "2.5.29.19",
      seq(
        new asn1.Boolean({ value: true }),
        asn1.Integer.fromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
      ),
    ],
  ])("reports %s as an error, not as a parsed value", (_case, oid, value) => {
    const result = buildExtension(extension(oid, value));
    expect(result).toMatchObject({ parseStatus: "error", parsed: undefined });
    expect(result.asn1).toBeDefined();
  });
});
