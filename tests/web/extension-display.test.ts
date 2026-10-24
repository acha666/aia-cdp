// The sections of decoded extension values: optional parts, one section per repeated element, the
// general-name prefixes and subtree ranges. How each value kind looks is in components.test.ts
// (ValueView, ExtensionView).
import { describe, expect, it } from "vitest";
import type { GeneralName } from "@/client/types";
import en from "@/locales/en.json";
import { describeExtension, describeSubtree } from "@/utils/extension-display";
import type { ExtensionContext } from "@/utils/extension-display";
import { formatGeneralName } from "@/utils/x509";

const ctx: ExtensionContext = {
  field: (key) => en.extension.fields[key],
  name: (name) => formatGeneralName(name, (type) => en.extension.generalName[type]),
  accessMethod: ({ oid, name }) =>
    (name !== null && en.extension.accessMethod[name as "ocsp"]) || (name ?? oid),
  time: (iso) => (iso === undefined ? "N/A" : `time(${iso})`),
  yesNo: (value) => (value ? "Yes" : "No"),
};

const uri = (value: string): GeneralName => ({ type: "uniformResourceIdentifier", value });
const LDAP =
  "ldap:///CN=Example%20Issuing%20CA%2001,CN=ca01,CN=CDP,CN=Public%20Key%20Services,CN=Services," +
  "CN=Configuration,DC=example,DC=test?deltaRevocationList?base?objectClass=cRLDistributionPoint";

describe("describeExtension", () => {
  it("omits the optional parts that are absent, and an empty value has no sections", () => {
    // An empty DistributionPoint (SEQUENCE {}) gives no rows, so no blank grid.
    expect(
      describeExtension({ extensionType: "cRLDistributionPoints", distributionPoints: [{}] }, ctx)
    ).toEqual([]);
    const aki = "3F1C2B4D5E6F708192A3B4C5D6E7F8091A2B3C4D";
    expect(describeExtension({ extensionType: "basicConstraints", cA: false }, ctx)).toEqual([
      [{ label: "CA", value: "No" }],
    ]);
    expect(
      describeExtension({ extensionType: "authorityKeyIdentifier", keyIdentifier: aki }, ctx)
    ).toEqual([[{ label: "Key ID", value: { hex: aki } }]]);
    expect(describeExtension({ extensionType: "nameConstraints" }, ctx)).toEqual([]);
    expect(describeExtension({ extensionType: "policyConstraints" }, ctx)).toEqual([]);
    // 0 is a value, not an absent one.
    expect(
      describeExtension({ extensionType: "policyConstraints", requireExplicitPolicy: 0 }, ctx)
    ).toEqual([[{ label: "Require explicit policy", value: "0" }]]);
    expect(
      describeExtension(
        { extensionType: "msCertificateTemplate", templateId: { oid: "1.2.3", name: "T" } },
        ctx
      )
    ).toEqual([
      [
        { label: "Template OID", value: "T (1.2.3)" },
        { label: "Template version", value: "0.0" },
      ],
    ]);
  });

  it("labels AIA locations with their access method", () => {
    expect(
      describeExtension(
        {
          extensionType: "authorityInfoAccess",
          accessDescriptions: [
            {
              accessMethod: { oid: "1.3.6.1.5.5.7.48.2", name: "caIssuers" },
              accessLocation: uri("http://pki.example.test/ca/issuing-ca-1.crt"),
            },
            {
              accessMethod: { oid: "1.3.6.1.5.5.7.48.1", name: "ocsp" },
              accessLocation: uri("http://ocsp.example.test/"),
            },
          ],
        },
        ctx
      )
    ).toEqual([
      [
        {
          label: "CA Issuers",
          value: { lines: ["URI: http://pki.example.test/ca/issuing-ca-1.crt"] },
        },
        { label: "OCSP", value: { lines: ["URI: http://ocsp.example.test/"] } },
      ],
    ]);
  });

  it("gives each distribution point its own section: full name, reasons, CRL issuer", () => {
    // full-adcs's Freshest CRL: one point, an http and an ldap URI.
    expect(
      describeExtension(
        {
          extensionType: "freshestCRL",
          distributionPoints: [
            {
              distributionPoint: {
                fullName: [uri("http://pki.example.test/dcrl/issuing-ca-1.crl"), uri(LDAP)],
              },
            },
          ],
        },
        ctx
      )
    ).toEqual([
      [
        {
          label: "Full name",
          value: { lines: ["URI: http://pki.example.test/dcrl/issuing-ca-1.crl", `URI: ${LDAP}`] },
        },
      ],
    ]);
    expect(
      describeExtension(
        {
          extensionType: "cRLDistributionPoints",
          distributionPoints: [
            { distributionPoint: { fullName: [uri("http://a.test/1.crl")] } },
            {
              distributionPoint: {
                nameRelativeToCRLIssuer: {
                  attributes: [
                    {
                      type: { oid: "2.5.4.3", name: "commonName" },
                      value: { string: "CRL1", encoding: "utf8String" },
                    },
                  ],
                },
              },
              reasons: ["keyCompromise"],
              cRLIssuer: [{ type: "directoryName", value: "CN=Other CA" }],
            },
          ],
        },
        ctx
      )
    ).toEqual([
      [{ label: "Full name", value: { lines: ["URI: http://a.test/1.crl"] } }],
      [
        { label: "Relative to CRL issuer", value: { lines: ["commonName=CRL1"] } },
        { label: "Reasons", value: { tags: ["keyCompromise"] } },
        { label: "CRL issuer", value: { lines: ["DirName: CN=Other CA"] } },
      ],
    ]);
  });

  it("gives each policy its own section with its qualifiers, and each SCT its own section", () => {
    expect(
      describeExtension(
        {
          extensionType: "certificatePolicies",
          policies: [
            { policyIdentifier: { oid: "2.23.140.1.2.1", name: "CA/Browser Forum DV" } },
            {
              policyIdentifier: { oid: "2.5.29.32.0", name: "anyPolicy" },
              policyQualifiers: [
                {
                  qualifierId: { oid: "1.3.6.1.5.5.7.2.1", name: "cps" },
                  cpsUri: "http://pki.example.test/cps",
                  rawHex: "16",
                },
                {
                  qualifierId: { oid: "1.3.6.1.5.5.7.2.2", name: "unotice" },
                  userNotice: {
                    organization: "Example PKI",
                    noticeNumbers: ["1", "2"],
                    explicitText: "Test use only",
                  },
                  rawHex: "30",
                },
                { qualifierId: { oid: "1.3.6.1.4.1.32473.4", name: null }, rawHex: "0500" },
              ],
            },
          ],
        },
        ctx
      )
    ).toEqual([
      [{ label: "Policy", value: "CA/Browser Forum DV (2.23.140.1.2.1)" }],
      [
        { label: "Policy", value: "anyPolicy (2.5.29.32.0)" },
        { label: "CPS", value: { lines: ["http://pki.example.test/cps"] } },
        { label: "User notice", value: "Example PKI (1, 2)\nTest use only" },
        { label: "1.3.6.1.4.1.32473.4", value: { hex: "0500" } },
      ],
    ]);
    const sct = {
      version: 0,
      logId: "AB",
      timestamp: "2026-01-01T00:00:00.000Z",
      hashAlgorithm: "sha256",
      signatureAlgorithm: "ecdsa",
      signature: "30",
    };
    const sections = describeExtension(
      { extensionType: "signedCertificateTimestampList", timestamps: [sct, sct] },
      ctx
    );
    expect(sections).toHaveLength(2);
    expect(sections?.[1]).toEqual([
      { label: "Log ID", value: { hex: "AB" } },
      { label: "Timestamp", value: "time(2026-01-01T00:00:00.000Z)" },
      { label: "Signature", value: "sha256/ecdsa" },
    ]);
  });

  it("lists an IDP's name, its reasons and its true scope flags as rows", () => {
    expect(
      describeExtension(
        {
          extensionType: "issuingDistributionPoint",
          distributionPoint: { fullName: [uri("http://pki.example.test/u.crl")] },
          onlyContainsUserCerts: true,
          onlyContainsCACerts: false,
          indirectCRL: true,
          onlyContainsAttributeCerts: false,
          onlySomeReasons: ["keyCompromise", "superseded"],
        },
        ctx
      )
    ).toEqual([
      [
        { label: "Full name", value: { lines: ["URI: http://pki.example.test/u.crl"] } },
        { label: "Reasons", value: { tags: ["keyCompromise", "superseded"] } },
        { label: "Only user certificates", value: "Yes" },
        { label: "Indirect CRL", value: "Yes" },
      ],
    ]);
  });

  it("prefixes general names with their type label, otherName with its own name or type OID", () => {
    const names: GeneralName[] = [
      { type: "dNSName", value: "leaf.example.test" },
      { type: "iPAddress", value: "2001:db8::10" },
      {
        type: "otherName",
        value: "leaf@example.test",
        typeOid: "1.3.6.1.4.1.311.20.2.3",
        typeName: "userPrincipalName",
      },
      { type: "otherName", value: "x", typeOid: "1.3.6.1.4.1.32473.2" },
      { type: "x400Address", value: "", rawHex: "a003" },
    ];
    expect(describeExtension({ extensionType: "subjectAltName", names }, ctx)).toEqual([
      [
        {
          label: "Names",
          value: {
            lines: [
              "DNS: leaf.example.test",
              "IP: 2001:db8::10",
              "userPrincipalName: leaf@example.test",
              "1.3.6.1.4.1.32473.2: x",
              "X.400: a003",
            ],
          },
        },
      ],
    ]);
  });

  it("writes subtree ranges as [min–max] and only when given", () => {
    const dns: GeneralName = { type: "dNSName", value: "example.test" };
    expect(describeSubtree({ base: dns, minimum: 0 }, ctx)).toBe("DNS: example.test");
    expect(describeSubtree({ base: dns, minimum: 0, maximum: 2 }, ctx)).toBe(
      "DNS: example.test [0–2]"
    );
    expect(describeSubtree({ base: dns, minimum: 1, maximum: 3 }, ctx)).toBe(
      "DNS: example.test [1–3]"
    );
  });
});
