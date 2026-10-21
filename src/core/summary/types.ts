// Types of the X.509 projection (schemas.ts) under the names the builders and the slice 5b views
// use: the type exports of worker-aia-cdp@5b570aa:src/contracts/schemas.ts:768-866 that name a
// migrated schema, plus DistributionPointName and ExtensionType. Type-only imports, so the web
// client can import this module without bundling zod (implementation §2.1).
import type { z } from "zod";
import type {
  AccessDescriptionSchema,
  AlgorithmIdentifierSchema,
  AlgorithmParametersParsedSchema,
  AlgorithmParametersSchema,
  Asn1LineSchema,
  AttributeTypeAndValueSchema,
  AttributeValueSchema,
  AuthorityInfoAccessValueSchema,
  AuthorityKeyIdentifierValueSchema,
  BasicConstraintsValueSchema,
  BitStringSchema,
  CertificateIssuerValueSchema,
  CertificatePoliciesValueSchema,
  CRLDistributionPointsValueSchema,
  CRLNumberValueSchema,
  CRLReasonValueSchema,
  DeltaCRLIndicatorValueSchema,
  DistributionPointNameSchema,
  DistributionPointSchema,
  ECPublicKeySchema,
  EdPublicKeySchema,
  ExpiredCertsOnCRLValueSchema,
  ExtendedKeyUsageValueSchema,
  ExtensionSchema,
  ExtensionsSchema,
  FingerprintsSchema,
  FreshestCRLValueSchema,
  GeneralNameSchema,
  GeneralSubtreeSchema,
  HoldInstructionCodeValueSchema,
  InhibitAnyPolicyValueSchema,
  InvalidityDateValueSchema,
  IssuerAltNameValueSchema,
  IssuingDistributionPointValueSchema,
  KeyUsageValueSchema,
  MsApplicationPoliciesValueSchema,
  MsCaVersionValueSchema,
  MsCertificateTemplateNameValueSchema,
  MsCertificateTemplateValueSchema,
  MsCrlNextPublishValueSchema,
  MsCrlSelfCdpValueSchema,
  MsCrlVirtualBaseValueSchema,
  MsNtdsCaSecurityValueSchema,
  MsPreviousCaCertificateHashValueSchema,
  NameConstraintsValueSchema,
  NameSchema,
  NetscapeCertTypeValueSchema,
  NetscapeCommentValueSchema,
  ObjectIdentifierSchema,
  OcspNoCheckValueSchema,
  ParsedExtensionValueSchema,
  PolicyConstraintsValueSchema,
  PolicyInformationSchema,
  PolicyMappingsValueSchema,
  PolicyQualifierSchema,
  PrivateKeyUsagePeriodValueSchema,
  QcStatementsValueSchema,
  RelativeDistinguishedNameSchema,
  RevokedCertificateSchema,
  RevokedCertificatesSchema,
  RSAPublicKeySchema,
  SerialNumberSchema,
  SignatureValueSchema,
  SignedCertificateTimestampListValueSchema,
  SubjectAltNameValueSchema,
  SubjectDirectoryAttributesValueSchema,
  SubjectInfoAccessValueSchema,
  SubjectKeyIdentifierValueSchema,
  SubjectPublicKeyInfoSchema,
  TBSCertificateSchema,
  TBSCertListSchema,
  TimeSchema,
  TlsFeatureValueSchema,
  UnknownPublicKeySchema,
  UserNoticeSchema,
  X509VersionSchema,
} from "./schemas.ts";

export type X509Version = z.infer<typeof X509VersionSchema>;
export type SerialNumber = z.infer<typeof SerialNumberSchema>;
export type BitString = z.infer<typeof BitStringSchema>;
export type ObjectIdentifier = z.infer<typeof ObjectIdentifierSchema>;
export type AlgorithmIdentifier = z.infer<typeof AlgorithmIdentifierSchema>;
export type AlgorithmParameters = z.infer<typeof AlgorithmParametersSchema>;
export type AlgorithmParametersParsed = z.infer<typeof AlgorithmParametersParsedSchema>;
export type SignatureValue = z.infer<typeof SignatureValueSchema>;
export type Asn1Line = z.infer<typeof Asn1LineSchema>;
export type Time = z.infer<typeof TimeSchema>;
export type Name = z.infer<typeof NameSchema>;
export type Fingerprints = z.infer<typeof FingerprintsSchema>;
export type SubjectPublicKeyInfo = z.infer<typeof SubjectPublicKeyInfoSchema>;
export type Extension = z.infer<typeof ExtensionSchema>;
export type Extensions = z.infer<typeof ExtensionsSchema>;
export type TBSCertificate = z.infer<typeof TBSCertificateSchema>;
export type RevokedCertificate = z.infer<typeof RevokedCertificateSchema>;
export type TBSCertList = z.infer<typeof TBSCertListSchema>;

export type RelativeDistinguishedName = z.infer<typeof RelativeDistinguishedNameSchema>;
export type AttributeTypeAndValue = z.infer<typeof AttributeTypeAndValueSchema>;
export type AttributeValue = z.infer<typeof AttributeValueSchema>;
export type RSAPublicKey = z.infer<typeof RSAPublicKeySchema>;
export type ECPublicKey = z.infer<typeof ECPublicKeySchema>;
export type EdPublicKey = z.infer<typeof EdPublicKeySchema>;
export type UnknownPublicKey = z.infer<typeof UnknownPublicKeySchema>;
export type GeneralName = z.infer<typeof GeneralNameSchema>;
export type RevokedCertificates = z.infer<typeof RevokedCertificatesSchema>;

export type DistributionPointName = z.infer<typeof DistributionPointNameSchema>;
export type DistributionPoint = z.infer<typeof DistributionPointSchema>;
export type PolicyQualifier = z.infer<typeof PolicyQualifierSchema>;
export type UserNotice = z.infer<typeof UserNoticeSchema>;
export type PolicyInformation = z.infer<typeof PolicyInformationSchema>;
export type AccessDescription = z.infer<typeof AccessDescriptionSchema>;
export type GeneralSubtree = z.infer<typeof GeneralSubtreeSchema>;
export type ParsedExtensionValue = z.infer<typeof ParsedExtensionValueSchema>;
export type BasicConstraintsValue = z.infer<typeof BasicConstraintsValueSchema>;
export type KeyUsageValue = z.infer<typeof KeyUsageValueSchema>;
export type ExtendedKeyUsageValue = z.infer<typeof ExtendedKeyUsageValueSchema>;
export type SubjectAltNameValue = z.infer<typeof SubjectAltNameValueSchema>;
export type AuthorityKeyIdentifierValue = z.infer<typeof AuthorityKeyIdentifierValueSchema>;
export type SubjectKeyIdentifierValue = z.infer<typeof SubjectKeyIdentifierValueSchema>;
export type CRLDistributionPointsValue = z.infer<typeof CRLDistributionPointsValueSchema>;
export type AuthorityInfoAccessValue = z.infer<typeof AuthorityInfoAccessValueSchema>;
export type CertificatePoliciesValue = z.infer<typeof CertificatePoliciesValueSchema>;
export type NameConstraintsValue = z.infer<typeof NameConstraintsValueSchema>;
export type CRLNumberValue = z.infer<typeof CRLNumberValueSchema>;
export type DeltaCRLIndicatorValue = z.infer<typeof DeltaCRLIndicatorValueSchema>;
export type IssuingDistributionPointValue = z.infer<typeof IssuingDistributionPointValueSchema>;
export type CRLReasonValue = z.infer<typeof CRLReasonValueSchema>;
export type InvalidityDateValue = z.infer<typeof InvalidityDateValueSchema>;
export type FreshestCRLValue = z.infer<typeof FreshestCRLValueSchema>;
export type IssuerAltNameValue = z.infer<typeof IssuerAltNameValueSchema>;
export type SubjectInfoAccessValue = z.infer<typeof SubjectInfoAccessValueSchema>;
export type PolicyConstraintsValue = z.infer<typeof PolicyConstraintsValueSchema>;
export type PolicyMappingsValue = z.infer<typeof PolicyMappingsValueSchema>;
export type InhibitAnyPolicyValue = z.infer<typeof InhibitAnyPolicyValueSchema>;
export type PrivateKeyUsagePeriodValue = z.infer<typeof PrivateKeyUsagePeriodValueSchema>;
export type CertificateIssuerValue = z.infer<typeof CertificateIssuerValueSchema>;
export type HoldInstructionCodeValue = z.infer<typeof HoldInstructionCodeValueSchema>;
export type ExpiredCertsOnCRLValue = z.infer<typeof ExpiredCertsOnCRLValueSchema>;
export type SignedCertificateTimestampListValue = z.infer<
  typeof SignedCertificateTimestampListValueSchema
>;
export type TlsFeatureValue = z.infer<typeof TlsFeatureValueSchema>;
export type OcspNoCheckValue = z.infer<typeof OcspNoCheckValueSchema>;
export type NetscapeCertTypeValue = z.infer<typeof NetscapeCertTypeValueSchema>;
export type NetscapeCommentValue = z.infer<typeof NetscapeCommentValueSchema>;
export type QcStatementsValue = z.infer<typeof QcStatementsValueSchema>;
export type SubjectDirectoryAttributesValue = z.infer<typeof SubjectDirectoryAttributesValueSchema>;
export type MsCaVersionValue = z.infer<typeof MsCaVersionValueSchema>;
export type MsCertificateTemplateNameValue = z.infer<typeof MsCertificateTemplateNameValueSchema>;
export type MsCertificateTemplateValue = z.infer<typeof MsCertificateTemplateValueSchema>;
export type MsPreviousCaCertificateHashValue = z.infer<
  typeof MsPreviousCaCertificateHashValueSchema
>;
export type MsCrlNextPublishValue = z.infer<typeof MsCrlNextPublishValueSchema>;
export type MsCrlSelfCdpValue = z.infer<typeof MsCrlSelfCdpValueSchema>;
export type MsCrlVirtualBaseValue = z.infer<typeof MsCrlVirtualBaseValueSchema>;
export type MsApplicationPoliciesValue = z.infer<typeof MsApplicationPoliciesValueSchema>;
export type MsNtdsCaSecurityValue = z.infer<typeof MsNtdsCaSecurityValueSchema>;

/** The 41 `extensionType` discriminants (src/core/summary/extensions.ts produces each). */
export type ExtensionType = ParsedExtensionValue["extensionType"];
