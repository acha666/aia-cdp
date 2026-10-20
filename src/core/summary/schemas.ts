// X.509 projection schemas: what the detail builders (primitives.ts, extensions.ts,
// certificate.ts, crl.ts) return, and what the certificate and CRL detail routes document
// (implementation slice 5a step 1). From worker-aia-cdp@5b570aa:src/contracts/schemas.ts:12-497,
// 542-556 and 578-604; the v2 envelope, storage, pagination and query schemas are not migrated, and
// the CRL kind comes from config (CrlKind in ../catalog.ts).
//
// Changes from the source: no "unknown" extension variant (no parser produced it, §10 #8); fields
// the builders always produce are required (SubjectPublicKeyInfo.parsed, ECPublicKey.point.x / y,
// TBSCertList.version); revokedCertificates is { count, items } with every entry (no pagination);
// DistributionPointName is a schema of its own, shared by DistributionPoint and the IDP.
//
// Named schemas carry `.meta({ id })` where they are defined: a derived instance (`.extend()`,
// `.shape.x`) does not inherit the id, and the OpenAPI generator only writes
// `discriminator.mapping` when every member of a union has one (implementation §2.1). The 41
// `extensionType` literals and the field names are the contract with the slice 5b views.
import { z } from "zod";

// =============================================================================
// X.509 Primitive Schemas
// =============================================================================

export const X509VersionSchema = z.object({
  raw: z.number(),
  display: z.enum(["v1", "v2", "v3"]),
});

export const SerialNumberSchema = z.object({
  hex: z.string(),
  decimal: z.string().optional(),
});

export const BitStringSchema = z.object({
  hex: z.string(),
  bitLength: z.number(),
  unusedBits: z.number(),
});

export const ObjectIdentifierSchema = z.object({
  oid: z.string(),
  name: z.string().nullable(),
});

export const SignatureValueSchema = BitStringSchema.extend({
  parsed: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("ecdsa"), r: z.string(), s: z.string() }),
      z.object({ type: z.literal("dsa"), r: z.string(), s: z.string() }),
    ])
    .optional(),
}).meta({ id: "SignatureValue" });

export const AlgorithmParametersParsedSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("null") }),
  z.object({ type: z.literal("objectIdentifier"), oid: ObjectIdentifierSchema }),
  z.object({
    type: z.literal("rsassaPss"),
    hashAlgorithm: ObjectIdentifierSchema,
    maskGenAlgorithm: ObjectIdentifierSchema,
    maskGenHashAlgorithm: ObjectIdentifierSchema.optional(),
    saltLength: z.number(),
    trailerField: z.number(),
  }),
]);

export const AlgorithmParametersSchema = z.object({
  rawHex: z.string().describe("DER encoding of the parameters value"),
  parsed: AlgorithmParametersParsedSchema.optional(),
});

export const AlgorithmIdentifierSchema = z
  .object({
    algorithm: ObjectIdentifierSchema,
    parameters: AlgorithmParametersSchema.optional(),
  })
  .meta({ id: "AlgorithmIdentifier" });

export const TimeSchema = z
  .object({
    iso: z.string(),
    type: z.enum(["utcTime", "generalizedTime"]),
    raw: z
      .string()
      .describe(
        "ASN.1 time text in RFC 5280 form (YYMMDDHHMMSSZ or YYYYMMDDHHMMSSZ). Objects carrying any other time encoding are rejected when parsed."
      ),
  })
  .meta({ id: "Time" });

// The lines of dumpAsn1 (Asn1Line in ../pki/asn1.ts); tests/core/summary/schemas.test.ts checks
// that the two types stay equal.
export const Asn1LineSchema = z.object({
  depth: z.number(),
  tag: z.string(),
  length: z.number(),
  value: z.string().optional(),
});

// =============================================================================
// Distinguished Name Schemas
// =============================================================================

export const AttributeValueSchema = z.object({
  string: z.string().nullable(),
  encoding: z.enum([
    "utf8String",
    "printableString",
    "ia5String",
    "bmpString",
    "universalString",
    "teletexString",
    "visibleString",
    "numericString",
    "generalString",
    "unknown",
  ]),
  rawHex: z.string().optional().describe("DER encoding of the value when it is not a string"),
});

export const AttributeTypeAndValueSchema = z.object({
  type: ObjectIdentifierSchema,
  value: AttributeValueSchema,
});

export const RelativeDistinguishedNameSchema = z.object({
  attributes: z.array(AttributeTypeAndValueSchema),
});

export const NameSchema = z
  .object({
    commonName: z.string().nullable(),
    organization: z.string().nullable(),
    organizationalUnit: z.string().nullable(),
    country: z.string().nullable(),
    stateOrProvince: z.string().nullable(),
    locality: z.string().nullable(),
    rdnSequence: z.array(RelativeDistinguishedNameSchema),
    rfc4514: z
      .string()
      .describe("RFC 4514 string form (most significant RDN last), with OpenSSL attribute names"),
  })
  .meta({ id: "Name" });

// =============================================================================
// Public Key Schemas
// =============================================================================

export const RSAPublicKeySchema = z.object({
  type: z.literal("rsa"),
  modulus: z.object({ hex: z.string(), bitLength: z.number() }),
  publicExponent: z.number(),
});

export const ECPublicKeySchema = z.object({
  type: z.literal("ec"),
  curve: ObjectIdentifierSchema,
  point: z.object({
    hex: z.string(),
    x: z.string(),
    y: z.string(),
  }),
  keySize: z.number(),
});

export const EdPublicKeySchema = z.object({
  type: z.enum(["ed25519", "ed448"]),
  publicKey: z.object({ hex: z.string() }),
});

export const UnknownPublicKeySchema = z.object({
  type: z.literal("unknown"),
});

export const PublicKeyParsedSchema = z.discriminatedUnion("type", [
  RSAPublicKeySchema,
  ECPublicKeySchema,
  EdPublicKeySchema,
  UnknownPublicKeySchema,
]);

export const FingerprintsSchema = z.object({
  sha1: z.string(),
  sha256: z.string(),
});

export const SubjectPublicKeyInfoSchema = z
  .object({
    algorithm: AlgorithmIdentifierSchema,
    subjectPublicKey: BitStringSchema,
    parsed: PublicKeyParsedSchema,
    fingerprints: FingerprintsSchema,
  })
  .meta({ id: "SubjectPublicKeyInfo" });

// =============================================================================
// General Name Schema
// =============================================================================

export const GeneralNameSchema = z
  .object({
    type: z.enum([
      "otherName",
      "rfc822Name",
      "dNSName",
      "x400Address",
      "directoryName",
      "ediPartyName",
      "uniformResourceIdentifier",
      "iPAddress",
      "registeredID",
    ]),
    value: z.string(),
    typeOid: z.string().optional().describe("otherName type-id"),
    typeName: z.string().optional().describe("Known name for otherName type-id"),
    rawHex: z.string().optional(),
  })
  .meta({ id: "GeneralName" });

// =============================================================================
// Extension Schemas
// =============================================================================

export const DistributionPointNameSchema = z
  .object({
    fullName: z.array(GeneralNameSchema).optional(),
    nameRelativeToCRLIssuer: RelativeDistinguishedNameSchema.optional(),
  })
  .meta({ id: "DistributionPointName" });
export const DistributionPointSchema = z
  .object({
    distributionPoint: DistributionPointNameSchema.optional(),
    reasons: z.array(z.string()).optional(),
    cRLIssuer: z.array(GeneralNameSchema).optional(),
  })
  .meta({ id: "DistributionPoint" });
export const UserNoticeSchema = z.object({
  organization: z.string().optional(),
  noticeNumbers: z.array(z.string()).optional(),
  explicitText: z.string().optional(),
});
export const PolicyQualifierSchema = z.object({
  qualifierId: ObjectIdentifierSchema,
  cpsUri: z.string().optional(),
  userNotice: UserNoticeSchema.optional(),
  rawHex: z.string(),
});
export const PolicyInformationSchema = z.object({
  policyIdentifier: ObjectIdentifierSchema,
  policyQualifiers: z.array(PolicyQualifierSchema).optional(),
});
export const AccessDescriptionSchema = z.object({
  accessMethod: ObjectIdentifierSchema,
  accessLocation: GeneralNameSchema,
});
export const GeneralSubtreeSchema = z.object({
  base: GeneralNameSchema,
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
export const BasicConstraintsValueSchema = z
  .object({
    extensionType: z.literal("basicConstraints"),
    cA: z.boolean(),
    pathLenConstraint: z.number().optional(),
  })
  .meta({ id: "BasicConstraintsValue" });
export const KeyUsageValueSchema = z
  .object({
    extensionType: z.literal("keyUsage"),
    digitalSignature: z.boolean(),
    nonRepudiation: z.boolean(),
    keyEncipherment: z.boolean(),
    dataEncipherment: z.boolean(),
    keyAgreement: z.boolean(),
    keyCertSign: z.boolean(),
    cRLSign: z.boolean(),
    encipherOnly: z.boolean(),
    decipherOnly: z.boolean(),
    usages: z.array(z.string()),
  })
  .meta({ id: "KeyUsageValue" });
export const ExtendedKeyUsageValueSchema = z
  .object({
    extensionType: z.literal("extendedKeyUsage"),
    purposes: z.array(ObjectIdentifierSchema),
  })
  .meta({ id: "ExtendedKeyUsageValue" });
export const SubjectAltNameValueSchema = z
  .object({
    extensionType: z.literal("subjectAltName"),
    names: z.array(GeneralNameSchema),
  })
  .meta({ id: "SubjectAltNameValue" });
export const AuthorityKeyIdentifierValueSchema = z
  .object({
    extensionType: z.literal("authorityKeyIdentifier"),
    keyIdentifier: z.string().optional(),
    authorityCertIssuer: z.array(GeneralNameSchema).optional(),
    authorityCertSerialNumber: z.string().optional(),
  })
  .meta({ id: "AuthorityKeyIdentifierValue" });
export const SubjectKeyIdentifierValueSchema = z
  .object({
    extensionType: z.literal("subjectKeyIdentifier"),
    keyIdentifier: z.string(),
  })
  .meta({ id: "SubjectKeyIdentifierValue" });
export const CRLDistributionPointsValueSchema = z
  .object({
    extensionType: z.literal("cRLDistributionPoints"),
    distributionPoints: z.array(DistributionPointSchema),
  })
  .meta({ id: "CRLDistributionPointsValue" });
export const AuthorityInfoAccessValueSchema = z
  .object({
    extensionType: z.literal("authorityInfoAccess"),
    accessDescriptions: z.array(AccessDescriptionSchema),
  })
  .meta({ id: "AuthorityInfoAccessValue" });
export const CertificatePoliciesValueSchema = z
  .object({
    extensionType: z.literal("certificatePolicies"),
    policies: z.array(PolicyInformationSchema),
  })
  .meta({ id: "CertificatePoliciesValue" });
export const NameConstraintsValueSchema = z
  .object({
    extensionType: z.literal("nameConstraints"),
    permittedSubtrees: z.array(GeneralSubtreeSchema).optional(),
    excludedSubtrees: z.array(GeneralSubtreeSchema).optional(),
  })
  .meta({ id: "NameConstraintsValue" });
export const CRLNumberValueSchema = z
  .object({
    extensionType: z.literal("cRLNumber"),
    number: z.string(),
  })
  .meta({ id: "CRLNumberValue" });
export const DeltaCRLIndicatorValueSchema = z
  .object({
    extensionType: z.literal("deltaCRLIndicator"),
    baseCRLNumber: z.string(),
  })
  .meta({ id: "DeltaCRLIndicatorValue" });
export const IssuingDistributionPointValueSchema = z
  .object({
    extensionType: z.literal("issuingDistributionPoint"),
    distributionPoint: DistributionPointNameSchema.optional(),
    onlyContainsUserCerts: z.boolean().optional(),
    onlyContainsCACerts: z.boolean().optional(),
    onlySomeReasons: z.array(z.string()).optional(),
    indirectCRL: z.boolean().optional(),
    onlyContainsAttributeCerts: z.boolean().optional(),
  })
  .meta({ id: "IssuingDistributionPointValue" });
export const CRLReasonValueSchema = z
  .object({
    extensionType: z.literal("cRLReason"),
    code: z.number(),
    name: z.string(),
  })
  .meta({ id: "CRLReasonValue" });
export const InvalidityDateValueSchema = z
  .object({
    extensionType: z.literal("invalidityDate"),
    date: TimeSchema,
  })
  .meta({ id: "InvalidityDateValue" });
export const FreshestCRLValueSchema = z
  .object({
    extensionType: z.literal("freshestCRL"),
    distributionPoints: z.array(DistributionPointSchema),
  })
  .meta({ id: "FreshestCRLValue" });
export const IssuerAltNameValueSchema = z
  .object({
    extensionType: z.literal("issuerAltName"),
    names: z.array(GeneralNameSchema),
  })
  .meta({ id: "IssuerAltNameValue" });
export const SubjectInfoAccessValueSchema = z
  .object({
    extensionType: z.literal("subjectInfoAccess"),
    accessDescriptions: z.array(AccessDescriptionSchema),
  })
  .meta({ id: "SubjectInfoAccessValue" });
export const PolicyConstraintsValueSchema = z
  .object({
    extensionType: z.literal("policyConstraints"),
    requireExplicitPolicy: z.number().optional(),
    inhibitPolicyMapping: z.number().optional(),
  })
  .meta({ id: "PolicyConstraintsValue" });
export const PolicyMappingsValueSchema = z
  .object({
    extensionType: z.literal("policyMappings"),
    mappings: z.array(
      z.object({
        issuerDomainPolicy: ObjectIdentifierSchema,
        subjectDomainPolicy: ObjectIdentifierSchema,
      })
    ),
  })
  .meta({ id: "PolicyMappingsValue" });
export const InhibitAnyPolicyValueSchema = z
  .object({
    extensionType: z.literal("inhibitAnyPolicy"),
    skipCerts: z.number(),
  })
  .meta({ id: "InhibitAnyPolicyValue" });
export const PrivateKeyUsagePeriodValueSchema = z
  .object({
    extensionType: z.literal("privateKeyUsagePeriod"),
    notBefore: TimeSchema.optional(),
    notAfter: TimeSchema.optional(),
  })
  .meta({ id: "PrivateKeyUsagePeriodValue" });
export const CertificateIssuerValueSchema = z
  .object({
    extensionType: z.literal("certificateIssuer"),
    names: z.array(GeneralNameSchema),
  })
  .meta({ id: "CertificateIssuerValue" });
export const HoldInstructionCodeValueSchema = z
  .object({
    extensionType: z.literal("holdInstructionCode"),
    instruction: ObjectIdentifierSchema,
  })
  .meta({ id: "HoldInstructionCodeValue" });
export const ExpiredCertsOnCRLValueSchema = z
  .object({
    extensionType: z.literal("expiredCertsOnCRL"),
    date: TimeSchema,
  })
  .meta({ id: "ExpiredCertsOnCRLValue" });
export const SignedCertificateTimestampListValueSchema = z
  .object({
    extensionType: z.literal("signedCertificateTimestampList"),
    timestamps: z.array(
      z.object({
        version: z.number(),
        logId: z.string(),
        timestamp: z.string(),
        hashAlgorithm: z.string(),
        signatureAlgorithm: z.string(),
        signature: z.string(),
      })
    ),
  })
  .meta({ id: "SignedCertificateTimestampListValue" });
export const TlsFeatureValueSchema = z
  .object({
    extensionType: z.literal("tlsFeature"),
    features: z.array(z.object({ code: z.number(), name: z.string().nullable() })),
  })
  .meta({ id: "TlsFeatureValue" });
export const OcspNoCheckValueSchema = z
  .object({ extensionType: z.literal("ocspNoCheck") })
  .meta({ id: "OcspNoCheckValue" });
export const NetscapeCertTypeValueSchema = z
  .object({
    extensionType: z.literal("netscapeCertType"),
    flags: z.array(z.string()),
  })
  .meta({ id: "NetscapeCertTypeValue" });
export const NetscapeCommentValueSchema = z
  .object({
    extensionType: z.literal("netscapeComment"),
    comment: z.string(),
  })
  .meta({ id: "NetscapeCommentValue" });
export const QcStatementsValueSchema = z
  .object({
    extensionType: z.literal("qcStatements"),
    statements: z.array(z.object({ statementId: ObjectIdentifierSchema, rawHex: z.string() })),
  })
  .meta({ id: "QcStatementsValue" });
export const SubjectDirectoryAttributesValueSchema = z
  .object({
    extensionType: z.literal("subjectDirectoryAttributes"),
    attributes: z.array(z.object({ type: ObjectIdentifierSchema, values: z.array(z.string()) })),
  })
  .meta({ id: "SubjectDirectoryAttributesValue" });
export const MsCaVersionValueSchema = z
  .object({
    extensionType: z.literal("msCaVersion"),
    certificateIndex: z.number(),
    keyIndex: z.number(),
  })
  .meta({ id: "MsCaVersionValue" });
export const MsCertificateTemplateNameValueSchema = z
  .object({
    extensionType: z.literal("msCertificateTemplateName"),
    name: z.string(),
  })
  .meta({ id: "MsCertificateTemplateNameValue" });
export const MsCertificateTemplateValueSchema = z
  .object({
    extensionType: z.literal("msCertificateTemplate"),
    templateId: ObjectIdentifierSchema,
    majorVersion: z.number().optional(),
    minorVersion: z.number().optional(),
  })
  .meta({ id: "MsCertificateTemplateValue" });
export const MsPreviousCaCertificateHashValueSchema = z
  .object({
    extensionType: z.literal("msPreviousCaCertificateHash"),
    hash: z.string(),
  })
  .meta({ id: "MsPreviousCaCertificateHashValue" });
export const MsCrlNextPublishValueSchema = z
  .object({
    extensionType: z.literal("msCrlNextPublish"),
    date: TimeSchema,
  })
  .meta({ id: "MsCrlNextPublishValue" });
export const MsCrlSelfCdpValueSchema = z
  .object({
    extensionType: z.literal("msCrlSelfCdp"),
    distributionPoints: z.array(DistributionPointSchema),
  })
  .meta({ id: "MsCrlSelfCdpValue" });
export const MsCrlVirtualBaseValueSchema = z
  .object({
    extensionType: z.literal("msCrlVirtualBase"),
    number: z.string(),
  })
  .meta({ id: "MsCrlVirtualBaseValue" });
export const MsApplicationPoliciesValueSchema = z
  .object({
    extensionType: z.literal("msApplicationPolicies"),
    policies: z.array(PolicyInformationSchema),
  })
  .meta({ id: "MsApplicationPoliciesValue" });
export const MsNtdsCaSecurityValueSchema = z
  .object({
    extensionType: z.literal("msNtdsCaSecurity"),
    sid: z.string(),
  })
  .meta({ id: "MsNtdsCaSecurityValue" });
export const ParsedExtensionValueSchema = z.discriminatedUnion("extensionType", [
  BasicConstraintsValueSchema,
  KeyUsageValueSchema,
  ExtendedKeyUsageValueSchema,
  SubjectAltNameValueSchema,
  AuthorityKeyIdentifierValueSchema,
  SubjectKeyIdentifierValueSchema,
  CRLDistributionPointsValueSchema,
  AuthorityInfoAccessValueSchema,
  CertificatePoliciesValueSchema,
  NameConstraintsValueSchema,
  CRLNumberValueSchema,
  DeltaCRLIndicatorValueSchema,
  IssuingDistributionPointValueSchema,
  CRLReasonValueSchema,
  InvalidityDateValueSchema,
  FreshestCRLValueSchema,
  IssuerAltNameValueSchema,
  SubjectInfoAccessValueSchema,
  PolicyConstraintsValueSchema,
  PolicyMappingsValueSchema,
  InhibitAnyPolicyValueSchema,
  PrivateKeyUsagePeriodValueSchema,
  CertificateIssuerValueSchema,
  HoldInstructionCodeValueSchema,
  ExpiredCertsOnCRLValueSchema,
  SignedCertificateTimestampListValueSchema,
  TlsFeatureValueSchema,
  OcspNoCheckValueSchema,
  NetscapeCertTypeValueSchema,
  NetscapeCommentValueSchema,
  QcStatementsValueSchema,
  SubjectDirectoryAttributesValueSchema,
  MsCaVersionValueSchema,
  MsCertificateTemplateNameValueSchema,
  MsCertificateTemplateValueSchema,
  MsPreviousCaCertificateHashValueSchema,
  MsCrlNextPublishValueSchema,
  MsCrlSelfCdpValueSchema,
  MsCrlVirtualBaseValueSchema,
  MsApplicationPoliciesValueSchema,
  MsNtdsCaSecurityValueSchema,
]);

export const ExtensionSchema = z
  .object({
    extnID: ObjectIdentifierSchema,
    critical: z.boolean(),
    extnValue: z.object({ hex: z.string(), byteLength: z.number() }),
    parseStatus: z.enum(["parsed", "unsupported", "error"]),
    parseError: z.string().optional(),
    parsed: ParsedExtensionValueSchema.optional(),
    asn1: z
      .array(Asn1LineSchema)
      .optional()
      .describe("Generic ASN.1 structure dump, present when the value is unsupported or malformed"),
  })
  .meta({ id: "Extension" });

export const ExtensionsSchema = z
  .object({
    count: z.number(),
    critical: z.number(),
    items: z.array(ExtensionSchema),
  })
  .meta({ id: "Extensions" });

// =============================================================================
// Certificate Schemas
// =============================================================================

export const TBSCertificateSchema = z
  .object({
    version: X509VersionSchema,
    serialNumber: SerialNumberSchema,
    signature: AlgorithmIdentifierSchema,
    issuer: NameSchema,
    validity: z.object({
      notBefore: TimeSchema,
      notAfter: TimeSchema,
    }),
    subject: NameSchema,
    subjectPublicKeyInfo: SubjectPublicKeyInfoSchema,
    issuerUniqueID: BitStringSchema.optional(),
    subjectUniqueID: BitStringSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .meta({ id: "TBSCertificate" });

// =============================================================================
// CRL Schemas
// =============================================================================

export const RevokedCertificateSchema = z
  .object({
    userCertificate: SerialNumberSchema,
    revocationDate: TimeSchema,
    crlEntryExtensions: z
      .object({
        count: z.number(),
        items: z.array(ExtensionSchema),
      })
      .optional(),
  })
  .meta({ id: "RevokedCertificate" });

/** Every entry of the CRL; an empty or absent list is { count: 0, items: [] }. */
export const RevokedCertificatesSchema = z.object({
  count: z.number(),
  items: z.array(RevokedCertificateSchema),
});

export const TBSCertListSchema = z
  .object({
    version: X509VersionSchema,
    signature: AlgorithmIdentifierSchema,
    issuer: NameSchema,
    thisUpdate: TimeSchema,
    nextUpdate: TimeSchema.optional(),
    revokedCertificates: RevokedCertificatesSchema,
    crlExtensions: ExtensionsSchema.optional(),
  })
  .meta({ id: "TBSCertList" });
