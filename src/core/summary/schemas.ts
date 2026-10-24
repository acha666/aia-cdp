// X.509 projection schemas and their z.infer types (Name for NameSchema, …): what the detail
// builders (primitives.ts, names.ts, extensions.ts, certificate.ts, crl.ts) return, and what the
// certificate and CRL detail routes document. The CRL kind is not here: it comes from config (CrlKind in
// ../catalog.ts).
//
// There is no "unknown" extension variant (no parser produces one); fields the builders always
// produce are required (SubjectPublicKeyInfo.parsed, ECPublicKey.point.x / y, TBSCertList.version);
// revokedCertificates is { count, items } with every entry (no pagination); DistributionPointName
// is a schema of its own, shared by DistributionPoint and the IDP.
//
// Named schemas carry `.meta({ id })` where they are defined: a derived instance (`.extend()`,
// `.shape.x`) does not inherit the id, and the OpenAPI generator only writes
// `discriminator.mapping` when every member of a union has one (implementation §2.1). The 41
// `extensionType` literals and the field names are the contract with the UI's views.
import { z } from "zod";

// =============================================================================
// X.509 Primitive Schemas
// =============================================================================

export const X509VersionSchema = z.object({
  raw: z.number(),
  display: z.enum(["v1", "v2", "v3"]),
});
export type X509Version = z.infer<typeof X509VersionSchema>;

export const SerialNumberSchema = z.object({
  hex: z.string(),
  decimal: z.string(),
});
export type SerialNumber = z.infer<typeof SerialNumberSchema>;

export const BitStringSchema = z.object({
  hex: z.string(),
  bitLength: z.number(),
  unusedBits: z.number(),
});
export type BitString = z.infer<typeof BitStringSchema>;

export const ObjectIdentifierSchema = z.object({
  oid: z.string(),
  name: z.string().nullable(),
});
export type ObjectIdentifier = z.infer<typeof ObjectIdentifierSchema>;

export const SignatureValueSchema = BitStringSchema.extend({
  parsed: z.object({ type: z.enum(["ecdsa", "dsa"]), r: z.string(), s: z.string() }).optional(),
}).meta({ id: "SignatureValue" });
export type SignatureValue = z.infer<typeof SignatureValueSchema>;

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
export type AlgorithmParametersParsed = z.infer<typeof AlgorithmParametersParsedSchema>;

export const AlgorithmParametersSchema = z.object({
  rawHex: z.string().describe("DER encoding of the parameters value"),
  parsed: AlgorithmParametersParsedSchema.optional(),
});
export type AlgorithmParameters = z.infer<typeof AlgorithmParametersSchema>;

export const AlgorithmIdentifierSchema = z
  .object({
    algorithm: ObjectIdentifierSchema,
    parameters: AlgorithmParametersSchema.optional(),
  })
  .meta({ id: "AlgorithmIdentifier" });
export type AlgorithmIdentifier = z.infer<typeof AlgorithmIdentifierSchema>;

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
export type Time = z.infer<typeof TimeSchema>;

// The lines of dumpAsn1 (Asn1Line in ../pki/asn1.ts). buildExtension assigns them to
// Extension.asn1, so the compiler checks that they fit this schema.
export const Asn1LineSchema = z.object({
  depth: z.number(),
  tag: z.string(),
  length: z.number(),
  value: z.string().optional(),
});
export type Asn1Line = z.infer<typeof Asn1LineSchema>;

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
export type AttributeValue = z.infer<typeof AttributeValueSchema>;

export const AttributeTypeAndValueSchema = z.object({
  type: ObjectIdentifierSchema,
  value: AttributeValueSchema,
});
export type AttributeTypeAndValue = z.infer<typeof AttributeTypeAndValueSchema>;

export const RelativeDistinguishedNameSchema = z.object({
  attributes: z.array(AttributeTypeAndValueSchema),
});
export type RelativeDistinguishedName = z.infer<typeof RelativeDistinguishedNameSchema>;

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
export type Name = z.infer<typeof NameSchema>;

// =============================================================================
// Public Key Schemas
// =============================================================================

export const RSAPublicKeySchema = z.object({
  type: z.literal("rsa"),
  modulus: z.object({ hex: z.string(), bitLength: z.number() }),
  publicExponent: z.number(),
});
export type RSAPublicKey = z.infer<typeof RSAPublicKeySchema>;

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
export type ECPublicKey = z.infer<typeof ECPublicKeySchema>;

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
export type Fingerprints = z.infer<typeof FingerprintsSchema>;

export const SubjectPublicKeyInfoSchema = z
  .object({
    algorithm: AlgorithmIdentifierSchema,
    subjectPublicKey: BitStringSchema,
    parsed: PublicKeyParsedSchema,
    fingerprints: FingerprintsSchema,
  })
  .meta({ id: "SubjectPublicKeyInfo" });
export type SubjectPublicKeyInfo = z.infer<typeof SubjectPublicKeyInfoSchema>;

// =============================================================================
// General Name Schema
// =============================================================================

/**
 * The GeneralName CHOICE alternatives in tag order: [n] is GENERAL_NAME_TYPES[n] (RFC 5280
 * §4.2.1.6). names.ts decodes the tag by this index, so the order is not free.
 */
export const GENERAL_NAME_TYPES = [
  "otherName",
  "rfc822Name",
  "dNSName",
  "x400Address",
  "directoryName",
  "ediPartyName",
  "uniformResourceIdentifier",
  "iPAddress",
  "registeredID",
] as const;

export const GeneralNameSchema = z
  .object({
    type: z.enum(GENERAL_NAME_TYPES),
    value: z.string(),
    typeOid: z.string().optional().describe("otherName type-id"),
    typeName: z.string().optional().describe("Known name for otherName type-id"),
    rawHex: z.string().optional(),
  })
  .meta({ id: "GeneralName" });
export type GeneralName = z.infer<typeof GeneralNameSchema>;

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
export type DistributionPoint = z.infer<typeof DistributionPointSchema>;

export const UserNoticeSchema = z.object({
  organization: z.string().optional(),
  noticeNumbers: z.array(z.string()).optional(),
  explicitText: z.string().optional(),
});
export type UserNotice = z.infer<typeof UserNoticeSchema>;

export const PolicyQualifierSchema = z.object({
  qualifierId: ObjectIdentifierSchema,
  cpsUri: z.string().optional(),
  userNotice: UserNoticeSchema.optional(),
  rawHex: z.string(),
});
export type PolicyQualifier = z.infer<typeof PolicyQualifierSchema>;

export const PolicyInformationSchema = z.object({
  policyIdentifier: ObjectIdentifierSchema,
  policyQualifiers: z.array(PolicyQualifierSchema).optional(),
});
export type PolicyInformation = z.infer<typeof PolicyInformationSchema>;

export const AccessDescriptionSchema = z.object({
  accessMethod: ObjectIdentifierSchema,
  accessLocation: GeneralNameSchema,
});
export type AccessDescription = z.infer<typeof AccessDescriptionSchema>;

export const GeneralSubtreeSchema = z.object({
  base: GeneralNameSchema,
  minimum: z.number(),
  maximum: z.number().optional(),
});
export type GeneralSubtree = z.infer<typeof GeneralSubtreeSchema>;

/**
 * A member of ParsedExtensionValueSchema: the `extensionType` literal, then `shape`. Its id is the
 * capitalized extensionType + "Value" (BasicConstraintsValue, CRLNumberValue, …).
 */
function extensionValue<const T extends string, S extends z.ZodRawShape>(
  extensionType: T,
  shape: S
) {
  const id = `${extensionType.charAt(0).toUpperCase()}${extensionType.slice(1)}Value`;
  return z.object({ extensionType: z.literal(extensionType), ...shape }).meta({ id });
}

export const ParsedExtensionValueSchema = z.discriminatedUnion("extensionType", [
  extensionValue("basicConstraints", { cA: z.boolean(), pathLenConstraint: z.number().optional() }),
  extensionValue("keyUsage", {
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
  }),
  extensionValue("extendedKeyUsage", { purposes: z.array(ObjectIdentifierSchema) }),
  extensionValue("subjectAltName", { names: z.array(GeneralNameSchema) }),
  extensionValue("authorityKeyIdentifier", {
    keyIdentifier: z.string().optional(),
    authorityCertIssuer: z.array(GeneralNameSchema).optional(),
    authorityCertSerialNumber: z.string().optional(),
  }),
  extensionValue("subjectKeyIdentifier", { keyIdentifier: z.string() }),
  extensionValue("cRLDistributionPoints", { distributionPoints: z.array(DistributionPointSchema) }),
  extensionValue("authorityInfoAccess", { accessDescriptions: z.array(AccessDescriptionSchema) }),
  extensionValue("certificatePolicies", { policies: z.array(PolicyInformationSchema) }),
  extensionValue("nameConstraints", {
    permittedSubtrees: z.array(GeneralSubtreeSchema).optional(),
    excludedSubtrees: z.array(GeneralSubtreeSchema).optional(),
  }),
  extensionValue("cRLNumber", { number: z.string() }),
  extensionValue("deltaCRLIndicator", { baseCRLNumber: z.string() }),
  extensionValue("issuingDistributionPoint", {
    distributionPoint: DistributionPointNameSchema.optional(),
    onlyContainsUserCerts: z.boolean(),
    onlyContainsCACerts: z.boolean(),
    onlySomeReasons: z.array(z.string()).optional(),
    indirectCRL: z.boolean(),
    onlyContainsAttributeCerts: z.boolean(),
  }),
  extensionValue("cRLReason", { code: z.number(), name: z.string() }),
  extensionValue("invalidityDate", { date: TimeSchema }),
  extensionValue("freshestCRL", { distributionPoints: z.array(DistributionPointSchema) }),
  extensionValue("issuerAltName", { names: z.array(GeneralNameSchema) }),
  extensionValue("subjectInfoAccess", { accessDescriptions: z.array(AccessDescriptionSchema) }),
  extensionValue("policyConstraints", {
    requireExplicitPolicy: z.number().optional(),
    inhibitPolicyMapping: z.number().optional(),
  }),
  extensionValue("policyMappings", {
    mappings: z.array(
      z.object({
        issuerDomainPolicy: ObjectIdentifierSchema,
        subjectDomainPolicy: ObjectIdentifierSchema,
      })
    ),
  }),
  extensionValue("inhibitAnyPolicy", { skipCerts: z.number() }),
  extensionValue("privateKeyUsagePeriod", {
    notBefore: TimeSchema.optional(),
    notAfter: TimeSchema.optional(),
  }),
  extensionValue("certificateIssuer", { names: z.array(GeneralNameSchema) }),
  extensionValue("holdInstructionCode", { instruction: ObjectIdentifierSchema }),
  extensionValue("expiredCertsOnCRL", { date: TimeSchema }),
  extensionValue("signedCertificateTimestampList", {
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
  }),
  extensionValue("tlsFeature", {
    features: z.array(z.object({ code: z.number(), name: z.string().nullable() })),
  }),
  extensionValue("ocspNoCheck", {}),
  extensionValue("netscapeCertType", { flags: z.array(z.string()) }),
  extensionValue("netscapeComment", { comment: z.string() }),
  extensionValue("qcStatements", {
    statements: z.array(z.object({ statementId: ObjectIdentifierSchema, rawHex: z.string() })),
  }),
  extensionValue("subjectDirectoryAttributes", {
    attributes: z.array(z.object({ type: ObjectIdentifierSchema, values: z.array(z.string()) })),
  }),
  extensionValue("msCaVersion", { certificateIndex: z.number(), keyIndex: z.number() }),
  extensionValue("msCertificateTemplateName", { name: z.string() }),
  extensionValue("msCertificateTemplate", {
    templateId: ObjectIdentifierSchema,
    majorVersion: z.number().optional(),
    minorVersion: z.number().optional(),
  }),
  extensionValue("msPreviousCaCertificateHash", { hash: z.string() }),
  extensionValue("msCrlNextPublish", { date: TimeSchema }),
  extensionValue("msCrlSelfCdp", { distributionPoints: z.array(DistributionPointSchema) }),
  extensionValue("msCrlVirtualBase", { number: z.string() }),
  extensionValue("msApplicationPolicies", { policies: z.array(PolicyInformationSchema) }),
  extensionValue("msNtdsCaSecurity", { sid: z.string() }),
]);
export type ParsedExtensionValue = z.infer<typeof ParsedExtensionValueSchema>;

/** The 41 `extensionType` discriminants (src/core/summary/extensions.ts produces each). */
export type ExtensionType = ParsedExtensionValue["extensionType"];

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
export type Extension = z.infer<typeof ExtensionSchema>;

export const ExtensionsSchema = z
  .object({
    count: z.number(),
    critical: z.number(),
    items: z.array(ExtensionSchema),
  })
  .meta({ id: "Extensions" });
export type Extensions = z.infer<typeof ExtensionsSchema>;

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
export type TBSCertificate = z.infer<typeof TBSCertificateSchema>;

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
export type RevokedCertificate = z.infer<typeof RevokedCertificateSchema>;

/** Every entry of the CRL; an empty or absent list is { count: 0, items: [] }. */
export const RevokedCertificatesSchema = z.object({
  count: z.number(),
  items: z.array(RevokedCertificateSchema),
});
export type RevokedCertificates = z.infer<typeof RevokedCertificatesSchema>;

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
export type TBSCertList = z.infer<typeof TBSCertListSchema>;
