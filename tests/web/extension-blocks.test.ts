// Render blocks of every decoded extension type (implementation slice 5b step 3). The 41
// extensionType literals of src/core/summary/schemas.ts are the contract between the server's
// projection and these views: CASES must have exactly one case per literal (a missing key fails
// to compile, an extra or stale one fails the first test), and every case must map to blocks
// rather than to the null fallback. Values follow the synthetic fixtures where they have one
// (tests/fixtures/generate-test-data.sh: leaf-full, issuing-ca-1, crls/issuing-ca-1/full-adcs).
import { describe, expect, it } from "vitest";
import { ParsedExtensionValueSchema } from "../../src/core/summary/schemas.ts";
import manifest from "../fixtures/pki/manifest.json";
import type {
  DistributionPoint,
  ExtensionType,
  GeneralName,
  ParsedExtensionValue,
  Time,
} from "@/client/types";
import en from "@/locales/en.json";
import { describeExtension, describeSubtree, oidText } from "@/utils/extension-blocks";
import type { Block, ExtensionContext } from "@/utils/extension-blocks";

const FIELDS: Record<string, string> = en.extension.fields;

/** The en texts, failing on a field key that has no message (a typo would show the raw key). */
const ctx: ExtensionContext = {
  field: (key) => {
    const message = FIELDS[key];
    if (message === undefined) {
      throw new Error(`No message for extension.fields.${key}`);
    }
    return message;
  },
  nameLabel: (type) => en.extension.generalName[type],
  time: (iso) => (iso === undefined ? "N/A" : `time(${iso})`),
  yesNo: (value) => (value ? "Yes" : "No"),
};

function utcTime(iso: string): Time {
  const normalized = new Date(iso).toISOString();
  return {
    iso: normalized,
    type: "utcTime",
    raw: `${normalized.replace(/[-:T]/g, "").slice(2, 14)}Z`,
  };
}

const adcsFull = manifest.crls.find((crl) => crl.file === "crls/issuing-ca-1/full-adcs.der")!;
const NEXT_PUBLISH = utcTime(adcsFull.nextPublish!);

const uri = (value: string): GeneralName => ({ type: "uniformResourceIdentifier", value });
const LEAF_SAN: GeneralName[] = [
  { type: "dNSName", value: "leaf.example.test" },
  { type: "iPAddress", value: "192.0.2.10" },
  { type: "iPAddress", value: "2001:db8::10" },
  uri("https://leaf.example.test/"),
  { type: "rfc822Name", value: "leaf@example.test" },
  {
    type: "otherName",
    value: "leaf@example.test",
    typeOid: "1.3.6.1.4.1.311.20.2.3",
    typeName: "userPrincipalName",
  },
];
const CDP: DistributionPoint[] = [
  { distributionPoint: { fullName: [uri("http://pki.example.test/crl/issuing-ca-1.crl")] } },
];
const LDAP_BASE =
  "ldap:///CN=Example%20Issuing%20CA%2001,CN=ca01,CN=CDP,CN=Public%20Key%20Services,CN=Services,CN=Configuration,DC=example,DC=test";
const FRESHEST: DistributionPoint[] = [
  {
    distributionPoint: {
      fullName: [
        uri("http://pki.example.test/dcrl/issuing-ca-1.crl"),
        uri(`${LDAP_BASE}?deltaRevocationList?base?objectClass=cRLDistributionPoint`),
      ],
    },
  },
];
const SELF_CDP: DistributionPoint[] = [
  {
    distributionPoint: {
      fullName: [
        uri(`${LDAP_BASE}?certificateRevocationList?base?objectClass=cRLDistributionPoint`),
      ],
    },
  },
];
const ROOT_NAME: GeneralName = {
  type: "directoryName",
  value: "CN=Example Root CA (ECC P-384),O=Example PKI,C=US",
};
const AKI = "3F1C2B4D5E6F708192A3B4C5D6E7F8091A2B3C4D";

type Value<K extends ExtensionType> = Extract<ParsedExtensionValue, { extensionType: K }>;
interface Case<K extends ExtensionType> {
  value: Value<K>;
  blocks: Block[];
}

const rows = (...list: [label: string, value: string, hex?: boolean][]): Block => ({
  kind: "rows",
  rows: list.map(([label, value, hex]) =>
    hex === undefined ? { label, value } : { label, value, hex }
  ),
});

const CASES: { [K in ExtensionType]: Case<K> } = {
  basicConstraints: {
    // ext_issuing: critical, CA:TRUE, pathlen:0.
    value: { extensionType: "basicConstraints", cA: true, pathLenConstraint: 0 },
    blocks: [rows(["CA", "Yes"], ["Path Length", "0"])],
  },
  keyUsage: {
    // ext_leaf_full: digitalSignature, keyAgreement.
    value: {
      extensionType: "keyUsage",
      digitalSignature: true,
      nonRepudiation: false,
      keyEncipherment: false,
      dataEncipherment: false,
      keyAgreement: true,
      keyCertSign: false,
      cRLSign: false,
      encipherOnly: false,
      decipherOnly: false,
      usages: ["digitalSignature", "keyAgreement"],
    },
    blocks: [{ kind: "tags", tags: ["digitalSignature", "keyAgreement"], tone: "blue" }],
  },
  extendedKeyUsage: {
    value: {
      extensionType: "extendedKeyUsage",
      purposes: [
        { oid: "1.3.6.1.5.5.7.3.1", name: "serverAuth" },
        { oid: "1.3.6.1.5.5.7.3.2", name: "clientAuth" },
        { oid: "1.3.6.1.4.1.32473.9", name: null },
      ],
    },
    blocks: [
      { kind: "tags", tags: ["serverAuth", "clientAuth", "1.3.6.1.4.1.32473.9"], tone: "purple" },
    ],
  },
  subjectAltName: {
    value: { extensionType: "subjectAltName", names: LEAF_SAN },
    blocks: [{ kind: "names", names: LEAF_SAN }],
  },
  authorityKeyIdentifier: {
    value: {
      extensionType: "authorityKeyIdentifier",
      keyIdentifier: AKI,
      authorityCertIssuer: [ROOT_NAME],
      authorityCertSerialNumber: "01",
    },
    blocks: [
      rows(["Key ID", AKI, true], ["Authority certificate serial", "01", true]),
      { kind: "names", title: "Authority certificate issuer", names: [ROOT_NAME] },
    ],
  },
  subjectKeyIdentifier: {
    value: { extensionType: "subjectKeyIdentifier", keyIdentifier: AKI },
    blocks: [rows(["Key ID", AKI, true])],
  },
  cRLDistributionPoints: {
    value: { extensionType: "cRLDistributionPoints", distributionPoints: CDP },
    blocks: [{ kind: "points", points: CDP }],
  },
  authorityInfoAccess: {
    // ext_leaf_full: caIssuers and OCSP.
    value: {
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
    blocks: [
      {
        kind: "access",
        items: [
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
    ],
  },
  certificatePolicies: {
    value: {
      extensionType: "certificatePolicies",
      policies: [
        { policyIdentifier: { oid: "2.23.140.1.2.1", name: "CA/Browser Forum DV" } },
        {
          policyIdentifier: { oid: "2.5.29.32.0", name: "anyPolicy" },
          policyQualifiers: [
            {
              qualifierId: { oid: "1.3.6.1.5.5.7.2.1", name: "cps" },
              cpsUri: "http://pki.example.test/cps",
              rawHex: "161b687474703a2f2f706b692e6578616d706c652e746573742f637073",
            },
          ],
        },
      ],
    },
    blocks: [
      {
        kind: "policies",
        policies: [
          { policyIdentifier: { oid: "2.23.140.1.2.1", name: "CA/Browser Forum DV" } },
          {
            policyIdentifier: { oid: "2.5.29.32.0", name: "anyPolicy" },
            policyQualifiers: [
              {
                qualifierId: { oid: "1.3.6.1.5.5.7.2.1", name: "cps" },
                cpsUri: "http://pki.example.test/cps",
                rawHex: "161b687474703a2f2f706b692e6578616d706c652e746573742f637073",
              },
            ],
          },
        ],
      },
    ],
  },
  nameConstraints: {
    value: {
      extensionType: "nameConstraints",
      permittedSubtrees: [{ base: { type: "dNSName", value: "example.test" } }],
      excludedSubtrees: [{ base: { type: "iPAddress", value: "10.0.0.0/8" }, minimum: 0 }],
    },
    blocks: [
      {
        kind: "subtrees",
        title: "Permitted",
        subtrees: [{ base: { type: "dNSName", value: "example.test" } }],
      },
      {
        kind: "subtrees",
        title: "Excluded",
        subtrees: [{ base: { type: "iPAddress", value: "10.0.0.0/8" }, minimum: 0 }],
      },
    ],
  },
  cRLNumber: {
    value: { extensionType: "cRLNumber", number: adcsFull.crlNumber! },
    blocks: [rows(["CRL Number", adcsFull.crlNumber!])],
  },
  deltaCRLIndicator: {
    value: { extensionType: "deltaCRLIndicator", baseCRLNumber: "19" },
    blocks: [rows(["Base CRL Number", "19"])],
  },
  issuingDistributionPoint: {
    // crl_ext_idp_scoped (onlyuser) plus reasons and the indirect flag.
    value: {
      extensionType: "issuingDistributionPoint",
      distributionPoint: { fullName: [uri("http://pki.example.test/crl/issuing-ca-1-users.crl")] },
      onlyContainsUserCerts: true,
      onlyContainsCACerts: false,
      indirectCRL: true,
      onlySomeReasons: ["keyCompromise", "superseded"],
    },
    blocks: [
      {
        kind: "points",
        points: [
          {
            distributionPoint: {
              fullName: [uri("http://pki.example.test/crl/issuing-ca-1-users.crl")],
            },
          },
        ],
      },
      { kind: "tags", tags: ["Only user certificates", "Indirect CRL"], tone: "purple" },
      { kind: "tags", tags: ["keyCompromise", "superseded"], tone: "amber" },
    ],
  },
  cRLReason: {
    // leaf-revoked in full-01: keyCompromise.
    value: { extensionType: "cRLReason", code: 1, name: "keyCompromise" },
    blocks: [rows(["Reason", "keyCompromise (1)"])],
  },
  invalidityDate: {
    value: { extensionType: "invalidityDate", date: utcTime("2025-12-20T00:00:00Z") },
    blocks: [rows(["Invalidity date", "time(2025-12-20T00:00:00.000Z)"])],
  },
  freshestCRL: {
    value: { extensionType: "freshestCRL", distributionPoints: FRESHEST },
    blocks: [{ kind: "points", points: FRESHEST }],
  },
  issuerAltName: {
    value: { extensionType: "issuerAltName", names: [uri("https://pki.example.test/")] },
    blocks: [{ kind: "names", names: [uri("https://pki.example.test/")] }],
  },
  subjectInfoAccess: {
    value: {
      extensionType: "subjectInfoAccess",
      accessDescriptions: [
        {
          accessMethod: { oid: "1.3.6.1.5.5.7.48.5", name: "caRepository" },
          accessLocation: uri("http://pki.example.test/ca/"),
        },
      ],
    },
    blocks: [
      {
        kind: "access",
        items: [
          {
            accessMethod: { oid: "1.3.6.1.5.5.7.48.5", name: "caRepository" },
            accessLocation: uri("http://pki.example.test/ca/"),
          },
        ],
      },
    ],
  },
  policyConstraints: {
    value: {
      extensionType: "policyConstraints",
      requireExplicitPolicy: 0,
      inhibitPolicyMapping: 1,
    },
    blocks: [rows(["Require explicit policy", "0"], ["Inhibit policy mapping", "1"])],
  },
  policyMappings: {
    value: {
      extensionType: "policyMappings",
      mappings: [
        {
          issuerDomainPolicy: { oid: "2.23.140.1.2.1", name: "CA/Browser Forum DV" },
          subjectDomainPolicy: { oid: "1.3.6.1.4.1.32473.1.1", name: null },
        },
      ],
    },
    blocks: [rows(["CA/Browser Forum DV (2.23.140.1.2.1)", "1.3.6.1.4.1.32473.1.1"])],
  },
  inhibitAnyPolicy: {
    value: { extensionType: "inhibitAnyPolicy", skipCerts: 0 },
    blocks: [rows(["Skip certificates", "0"])],
  },
  privateKeyUsagePeriod: {
    value: {
      extensionType: "privateKeyUsagePeriod",
      notBefore: {
        iso: "2025-01-01T00:00:00.000Z",
        type: "generalizedTime",
        raw: "20250101000000Z",
      },
    },
    blocks: [rows(["Not before", "time(2025-01-01T00:00:00.000Z)"], ["Not after", "N/A"])],
  },
  certificateIssuer: {
    value: { extensionType: "certificateIssuer", names: [ROOT_NAME] },
    blocks: [{ kind: "names", names: [ROOT_NAME] }],
  },
  holdInstructionCode: {
    value: {
      extensionType: "holdInstructionCode",
      instruction: { oid: "1.2.840.10040.2.1", name: "holdInstructionNone" },
    },
    blocks: [rows(["Hold instruction", "holdInstructionNone (1.2.840.10040.2.1)"])],
  },
  expiredCertsOnCRL: {
    value: { extensionType: "expiredCertsOnCRL", date: utcTime("2025-01-01T00:00:00Z") },
    blocks: [rows(["Expired certificates since", "time(2025-01-01T00:00:00.000Z)"])],
  },
  signedCertificateTimestampList: {
    value: {
      extensionType: "signedCertificateTimestampList",
      timestamps: [
        {
          version: 0,
          logId: "A4B90990B418581487BB13A2CC67700A3C359804F91BDFB8E377CD0EC80DDC10",
          timestamp: "2025-12-01T00:00:01.000Z",
          hashAlgorithm: "sha256",
          signatureAlgorithm: "ecdsa",
          signature: "3045022100AA",
        },
      ],
    },
    blocks: [
      rows(
        ["Log ID", "A4B90990B418581487BB13A2CC67700A3C359804F91BDFB8E377CD0EC80DDC10", true],
        ["Timestamp", "time(2025-12-01T00:00:01.000Z)"],
        ["Signature", "sha256/ecdsa"]
      ),
    ],
  },
  tlsFeature: {
    value: {
      extensionType: "tlsFeature",
      features: [
        { code: 5, name: "status_request" },
        { code: 99, name: null },
      ],
    },
    blocks: [{ kind: "tags", tags: ["status_request", "99"], tone: "blue" }],
  },
  ocspNoCheck: {
    value: { extensionType: "ocspNoCheck" },
    blocks: [rows(["OCSP no-check", "Yes"])],
  },
  netscapeCertType: {
    value: { extensionType: "netscapeCertType", flags: ["sslServer", "sslCA"] },
    blocks: [{ kind: "tags", tags: ["sslServer", "sslCA"], tone: "blue" }],
  },
  netscapeComment: {
    value: { extensionType: "netscapeComment", comment: "OpenSSL Generated Certificate" },
    blocks: [rows(["Comment", "OpenSSL Generated Certificate"])],
  },
  qcStatements: {
    value: {
      extensionType: "qcStatements",
      statements: [
        { statementId: { oid: "0.4.0.1862.1.1", name: "QcCompliance" }, rawHex: "" },
        { statementId: { oid: "0.4.0.1862.1.6", name: null }, rawHex: "3009060704008e460106" },
      ],
    },
    blocks: [
      // An empty value is rendered as "(empty)" by KeyValueList.
      rows(
        ["QcCompliance (0.4.0.1862.1.1)", "", false],
        ["0.4.0.1862.1.6", "3009060704008e460106", true]
      ),
    ],
  },
  subjectDirectoryAttributes: {
    value: {
      extensionType: "subjectDirectoryAttributes",
      attributes: [
        {
          type: { oid: "1.3.6.1.5.5.7.9.1", name: "dateOfBirth" },
          values: ["19700101000000Z"],
        },
        { type: { oid: "1.3.6.1.5.5.7.9.4", name: null }, values: ["US", "DE"] },
      ],
    },
    blocks: [
      rows(["dateOfBirth (1.3.6.1.5.5.7.9.1)", "19700101000000Z"], ["1.3.6.1.5.5.7.9.4", "US; DE"]),
    ],
  },
  msCaVersion: {
    // ext_issuing: CA Version V0.0 (INTEGER 0).
    value: { extensionType: "msCaVersion", certificateIndex: 0, keyIndex: 0 },
    blocks: [rows(["CA certificate index", "0"], ["CA key index", "0"])],
  },
  msCertificateTemplateName: {
    // ext_issuing: Certificate Template Name "SubCA" (BMPString).
    value: { extensionType: "msCertificateTemplateName", name: "SubCA" },
    blocks: [rows(["Template name", "SubCA"])],
  },
  msCertificateTemplate: {
    value: {
      extensionType: "msCertificateTemplate",
      templateId: { oid: "1.3.6.1.4.1.311.21.8.1.2.3", name: null },
      majorVersion: 100,
      minorVersion: 4,
    },
    blocks: [rows(["Template OID", "1.3.6.1.4.1.311.21.8.1.2.3"], ["Template version", "100.4"])],
  },
  msPreviousCaCertificateHash: {
    // ext_issuing_renewed: SHA-1 of the previous CA certificate.
    value: {
      extensionType: "msPreviousCaCertificateHash",
      hash: "B1C2D3E4F5061728394A5B6C7D8E9F0A1B2C3D4E",
    },
    blocks: [
      rows(["Previous CA certificate hash", "B1C2D3E4F5061728394A5B6C7D8E9F0A1B2C3D4E", true]),
    ],
  },
  msCrlNextPublish: {
    // crl_ext_adcs_full: Next CRL Publish as a UTCTime.
    value: { extensionType: "msCrlNextPublish", date: NEXT_PUBLISH },
    blocks: [rows(["Next CRL publish", `time(${NEXT_PUBLISH.iso})`])],
  },
  msCrlSelfCdp: {
    // crl_ext_adcs_full: CRL Self CDP, one LDAP URL.
    value: { extensionType: "msCrlSelfCdp", distributionPoints: SELF_CDP },
    blocks: [{ kind: "points", points: SELF_CDP }],
  },
  msCrlVirtualBase: {
    value: { extensionType: "msCrlVirtualBase", number: "18" },
    blocks: [rows(["CRL Number", "18"])],
  },
  msApplicationPolicies: {
    value: {
      extensionType: "msApplicationPolicies",
      policies: [
        { policyIdentifier: { oid: "1.3.6.1.5.5.7.3.1", name: "serverAuth" } },
        {
          policyIdentifier: { oid: "1.3.6.1.4.1.311.10.3.1", name: "Microsoft Trust List Signing" },
        },
      ],
    },
    blocks: [
      {
        kind: "policies",
        policies: [
          { policyIdentifier: { oid: "1.3.6.1.5.5.7.3.1", name: "serverAuth" } },
          {
            policyIdentifier: {
              oid: "1.3.6.1.4.1.311.10.3.1",
              name: "Microsoft Trust List Signing",
            },
          },
        ],
      },
    ],
  },
  msNtdsCaSecurity: {
    value: {
      extensionType: "msNtdsCaSecurity",
      sid: "S-1-5-21-3623811015-3361044348-30300820-1013",
    },
    blocks: [rows(["Security identifier (SID)", "S-1-5-21-3623811015-3361044348-30300820-1013"])],
  },
};

/** The discriminator values of the server's schema, at run time. */
const SCHEMA_TYPES = ParsedExtensionValueSchema.options.map(
  (option) => option.shape.extensionType.value
);

describe("describeExtension", () => {
  it("has exactly one case per extensionType of the server's schema", () => {
    expect(SCHEMA_TYPES).toHaveLength(41);
    expect(new Set(SCHEMA_TYPES).size).toBe(41);
    expect(Object.keys(CASES).sort()).toEqual([...SCHEMA_TYPES].sort());
  });

  it.each(SCHEMA_TYPES)("maps %s to its blocks", (type) => {
    const { value, blocks } = CASES[type];
    expect(value.extensionType).toBe(type);
    // A fixture value of this type passes the server's schema, so the cases test real shapes.
    expect(ParsedExtensionValueSchema.parse(value)).toEqual(value);
    const described = describeExtension(value, ctx);
    expect(described, "no block may fall back to the unknown-type null").not.toBeNull();
    expect(described).toEqual(blocks);
    expect(described!.length).toBeGreaterThan(0);
  });

  it("returns null for a type this build does not know (a newer server)", () => {
    const future = { extensionType: "brandNewExtension" } as unknown as ParsedExtensionValue;
    expect(describeExtension(future, ctx)).toBeNull();
  });

  it("omits the optional parts that are absent", () => {
    expect(describeExtension({ extensionType: "basicConstraints", cA: false }, ctx)).toEqual([
      rows(["CA", "No"]),
    ]);
    expect(
      describeExtension({ extensionType: "authorityKeyIdentifier", keyIdentifier: AKI }, ctx)
    ).toEqual([rows(["Key ID", AKI, true])]);
    expect(describeExtension({ extensionType: "nameConstraints" }, ctx)).toEqual([]);
    expect(
      describeExtension(
        { extensionType: "msCertificateTemplate", templateId: { oid: "1.2.3", name: "T" } },
        ctx
      )
    ).toEqual([rows(["Template OID", "T (1.2.3)"], ["Template version", "0.0"])]);
    expect(
      describeExtension({ extensionType: "policyConstraints", inhibitPolicyMapping: 2 }, ctx)
    ).toEqual([rows(["Inhibit policy mapping", "2"])]);
  });
});

describe("block texts", () => {
  it("keeps the CA Version's certificate and key indexes apart", () => {
    // A CA renewed with its old key: V1.0 (the fixture's CA Version is V0.0).
    expect(
      describeExtension({ extensionType: "msCaVersion", certificateIndex: 1, keyIndex: 0 }, ctx)
    ).toEqual([rows(["CA certificate index", "1"], ["CA key index", "0"])]);
  });

  it("writes subtree ranges as [min–max] and only when given", () => {
    const dns: GeneralName = { type: "dNSName", value: "example.test" };
    expect(describeSubtree({ base: dns }, ctx)).toBe("DNS: example.test");
    expect(describeSubtree({ base: dns, minimum: 0 }, ctx)).toBe("DNS: example.test [0]");
    expect(describeSubtree({ base: dns, maximum: 2 }, ctx)).toBe("DNS: example.test [0–2]");
    expect(describeSubtree({ base: dns, minimum: 1, maximum: 3 }, ctx)).toBe(
      "DNS: example.test [1–3]"
    );
  });

  it("names an OID with its known name first", () => {
    expect(oidText({ oid: "2.5.29.32.0", name: "anyPolicy" })).toBe("anyPolicy (2.5.29.32.0)");
    expect(oidText({ oid: "1.2.3", name: null })).toBe("1.2.3");
  });
});
