// Detail builders for X.509 extensions: one decoder per supported OID (41 extensionType values),
// a generic ASN.1 dump for the rest. Each decoder reads the value in strict DER through
// ../pki/der.ts: integers from their contents octets (asn1js's valueDec is 0 from four octets on;
// beyond a safe integer the extension is a parse error), and an SCT list must decode whole. The
// extensionType literals and field names are the contract with the UI's views. Key identifiers
// are uppercase hex here (for display); catalog summaries and ids are lowercase, so compare across
// endpoints only through the summary fields.
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import {
  EXTENSION_NAMES,
  EKU_NAMES,
  KEY_USAGE_FLAGS,
  REASON_FLAGS,
  NETSCAPE_CERT_TYPE_FLAGS,
  CRL_REASON_CODES,
  HOLD_INSTRUCTION_NAMES,
  ACCESS_METHOD_NAMES,
  POLICY_QUALIFIER_NAMES,
  CERTIFICATE_POLICY_NAMES,
  TLS_FEATURE_NAMES,
  QC_STATEMENT_NAMES,
} from "../pki/constants.ts";
import {
  plainExtension,
  readAuthorityKeyId,
  readCRLInteger,
  readSubjectKeyId,
} from "../pki/extensions.ts";
import type { PlainExtension } from "../pki/extensions.ts";
import {
  BIT_STRING,
  BOOLEAN,
  ENUMERATED,
  GENERALIZED_TIME,
  IA5_STRING,
  INTEGER,
  NULL,
  OBJECT_IDENTIFIER,
  OCTET_STRING,
  SEQUENCE,
  SET,
  DerReader,
  asUniversal,
  context,
  contents,
  expectTag,
  hasTag,
  explicit,
  readAscii,
  readBigInt,
  readBits,
  readBoolean,
  readDer,
  readInteger,
  readOid,
  sequenceOf,
} from "../pki/der.ts";
import { blockHex, displayText, dumpAsn1, readStrictTime, stringOf } from "../pki/asn1.ts";
import { messageOf } from "../pki/errors.ts";
import { toUpperHex } from "../digest.ts";
import type {
  AccessDescription,
  DistributionPoint,
  Extension,
  Extensions,
  ExtensionType,
  GeneralSubtree,
  ParsedExtensionValue,
  PolicyInformation,
  PolicyQualifier,
  Time,
  UserNotice,
} from "./schemas.ts";
import { buildObjectIdentifier } from "./primitives.ts";
import {
  readGeneralName,
  readGeneralNames,
  readOtherNameParts,
  readRelativeName,
} from "./names.ts";

export function buildExtensions(extensions: pkijs.Extension[] | undefined): Extensions | undefined {
  if (!extensions?.length) {
    return undefined;
  }
  const items = extensions.map(buildExtension);
  return { count: items.length, critical: items.filter((ext) => ext.critical).length, items };
}

export function buildExtension(ext: pkijs.Extension): Extension {
  return extensionOf(plainExtension(ext));
}

/** The detail of an extension as plain values: a revoked entry's (parseCRL), or buildExtension's. */
export function extensionOf(ext: PlainExtension): Extension {
  const bytes = ext.value;
  const result: Extension = {
    extnID: buildObjectIdentifier(ext.extnID, EXTENSION_NAMES),
    critical: ext.critical,
    extnValue: { hex: toUpperHex(bytes), byteLength: bytes.length },
    parseStatus: "unsupported",
  };
  try {
    result.parsed = PARSER_BY_OID[ext.extnID]?.(readDer(bytes));
    if (result.parsed) {
      result.parseStatus = "parsed";
    }
  } catch (error) {
    result.parseStatus = "error";
    result.parseError = messageOf(error);
  }
  if (result.parseStatus !== "parsed") {
    // Give readers a structural view even when no dedicated decoder exists.
    result.asn1 = dumpAsn1(bytes);
  }
  return result;
}

// =============================================================================
// Shared value helpers
// =============================================================================

function timeFromBlock(block: BaseBlock): Time {
  const strict = readStrictTime(block);
  return { iso: strict.date.toISOString(), type: strict.type, raw: strict.raw };
}

/** The text of an element of an ASN.1 string type (DisplayText, DirectoryString); else throws. */
function readText(block: BaseBlock): string {
  const text = stringOf(block);
  if (text === undefined) {
    throw new Error("Expected an ASN.1 string");
  }
  return text;
}

// =============================================================================
// Distribution points, access descriptions and subtrees (their names: names.ts)
// =============================================================================

/** distributionPoint [0] DistributionPointName: a CHOICE, so explicitly tagged. */
function readDistributionPointName(block: BaseBlock): DistributionPoint["distributionPoint"] {
  const choice = explicit(block, context(0));
  if (hasTag(choice, context(0))) {
    return { fullName: readGeneralNames(choice, context(0)) };
  }
  if (hasTag(choice, context(1))) {
    return { nameRelativeToCRLIssuer: readRelativeName(choice) };
  }
  throw new Error("Invalid DistributionPointName");
}

/** ReasonFlags (the reasons of a DistributionPoint and an IDP's onlySomeReasons). */
const readReasons = (block: BaseBlock) => readBits(block, REASON_FLAGS);

/** DistributionPoint ::= SEQUENCE { [0] name, [1] reasons, [2] cRLIssuer }, all OPTIONAL. */
function readDistributionPoint(block: BaseBlock): DistributionPoint {
  const point = new DerReader(block);
  const distributionPoint = point.optional(context(0), readDistributionPointName);
  const reasons = point.optional(context(1), readReasons);
  const cRLIssuer = point.optional(context(2), (names) => readGeneralNames(names, context(2)));
  point.end();
  return { distributionPoint, reasons, cRLIssuer };
}

/** CRLDistributionPoints ::= SEQUENCE SIZE (1..MAX) OF DistributionPoint (also Freshest CRL). */
const readDistributionPoints = (root: BaseBlock) => sequenceOf(root).map(readDistributionPoint);

/** AuthorityInfoAccessSyntax ::= SEQUENCE SIZE (1..MAX) OF AccessDescription (also SIA). */
function readAccessDescriptions(root: BaseBlock): AccessDescription[] {
  return sequenceOf(root).map((block) => {
    const access = new DerReader(block);
    const accessMethod = buildObjectIdentifier(
      readOid(access.read(OBJECT_IDENTIFIER)),
      ACCESS_METHOD_NAMES
    );
    const accessLocation = readGeneralName(access.any());
    access.end();
    return { accessMethod, accessLocation };
  });
}

/** GeneralSubtree ::= SEQUENCE { base, minimum [0] DEFAULT 0, maximum [1] OPTIONAL } (IMPLICIT). */
function readGeneralSubtree(block: BaseBlock): GeneralSubtree {
  const subtree = new DerReader(block);
  const base = readGeneralName(subtree.any());
  const minimum = subtree.optional(context(0), readInteger) ?? 0;
  const maximum = subtree.optional(context(1), readInteger);
  subtree.end();
  return { base, minimum, maximum };
}

// =============================================================================
// Certificate policies
// =============================================================================

const CPS_QUALIFIER = "1.3.6.1.5.5.7.2.1";
const USER_NOTICE_QUALIFIER = "1.3.6.1.5.5.7.2.2";

/**
 * UserNotice ::= SEQUENCE { noticeRef OPTIONAL, explicitText DisplayText OPTIONAL }, where
 * NoticeReference ::= SEQUENCE { organization DisplayText, noticeNumbers SEQUENCE OF INTEGER }.
 */
function readUserNotice(block: BaseBlock): UserNotice {
  const notice = new DerReader(block);
  const reference = notice.optional(SEQUENCE);
  const explicitText = notice.optional();
  notice.end();
  const text = explicitText && readText(explicitText);
  if (!reference) {
    return { explicitText: text };
  }
  const ref = new DerReader(reference);
  const organization = readText(ref.any());
  const numbers = sequenceOf(ref.read(SEQUENCE), SEQUENCE, 0);
  ref.end();
  return {
    organization,
    noticeNumbers: numbers.map((number) => readBigInt(expectTag(number, INTEGER)).toString()),
    explicitText: text,
  };
}

/** The CPS pointer or user notice in a qualifier; one that does not decode keeps only its DER. */
function readQualifierValue(qualifierId: string, qualifier: BaseBlock) {
  try {
    if (qualifierId === CPS_QUALIFIER) {
      return { cpsUri: readText(qualifier) };
    }
    if (qualifierId === USER_NOTICE_QUALIFIER) {
      return { userNotice: readUserNotice(qualifier) };
    }
  } catch {
    // Shown as rawHex, like a qualifier of another type.
  }
  return {};
}

/** PolicyQualifierInfo ::= SEQUENCE { policyQualifierId, qualifier ANY DEFINED BY it } */
function readPolicyQualifier(block: BaseBlock): PolicyQualifier {
  const info = new DerReader(block);
  const qualifierId = readOid(info.read(OBJECT_IDENTIFIER));
  const qualifier = info.any();
  info.end();
  return {
    qualifierId: buildObjectIdentifier(qualifierId, POLICY_QUALIFIER_NAMES),
    rawHex: blockHex(qualifier),
    ...readQualifierValue(qualifierId, qualifier),
  };
}

/** certificatePolicies ::= SEQUENCE OF PolicyInformation { policyIdentifier, qualifiers OPTIONAL } */
function readPolicies(root: BaseBlock, names = CERTIFICATE_POLICY_NAMES): PolicyInformation[] {
  return sequenceOf(root).map((block) => {
    const policy = new DerReader(block);
    const policyIdentifier = buildObjectIdentifier(readOid(policy.read(OBJECT_IDENTIFIER)), names);
    const qualifiers = policy.optional(SEQUENCE);
    policy.end();
    return {
      policyIdentifier,
      policyQualifiers: qualifiers && sequenceOf(qualifiers).map(readPolicyQualifier),
    };
  });
}

// =============================================================================
// Signed certificate timestamps
// =============================================================================

/** The 16-bit length before each TLS vector (RFC 6962 §3.3, RFC 8446 §3.4). */
const lengthAt = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

/** SignedCertificateTimestampList: sct_list <1..2^16-1>, each SerializedSCT after its length. */
function checkSctFraming(list: Uint8Array): void {
  let at = 2;
  while (at < list.length) {
    at += 2 + lengthAt(list, at);
  }
  if (list.length <= 2 || lengthAt(list, 0) !== list.length - 2 || at !== list.length) {
    throw new Error("Invalid SCT list");
  }
}

function readSct(sct: pkijs.SignedCertificateTimestamp) {
  const signature = toUpperHex(sct.signature);
  // version is typed number but is undefined when the data ended before it.
  const version: unknown = sct.version;
  if (typeof version !== "number" || sct.logID.byteLength !== 32 || signature === "") {
    throw new Error("Invalid SCT");
  }
  return {
    version,
    logId: toUpperHex(sct.logID),
    timestamp: sct.timestamp.toISOString(),
    hashAlgorithm: sct.hashAlgorithm,
    signatureAlgorithm: sct.signatureAlgorithm,
    signature,
  };
}

// =============================================================================
// Extension parsers
// =============================================================================

/** A decoder of one OID: it gets the extension value as one element in strict DER. */
type ExtensionParser = (value: BaseBlock) => ParsedExtensionValue | undefined;

/** The member of ParsedExtensionValue for one extensionType: the return type of its parser. */
type Parsed<K extends ExtensionType> = Extract<ParsedExtensionValue, { extensionType: K }>;

const EXTENSION_PARSERS = {
  // Subject Directory Attributes (2.5.29.9): SEQUENCE OF Attribute { type, values SET OF ANY }
  "2.5.29.9": (value): Parsed<"subjectDirectoryAttributes"> => ({
    extensionType: "subjectDirectoryAttributes",
    attributes: sequenceOf(value).map((block) => {
      const attribute = new DerReader(block);
      const type = buildObjectIdentifier(readOid(attribute.read(OBJECT_IDENTIFIER)));
      const values = sequenceOf(attribute.read(SET), SET).map(displayText);
      attribute.end();
      return { type, values };
    }),
  }),

  // Subject Key Identifier (2.5.29.14)
  "2.5.29.14": (value): Parsed<"subjectKeyIdentifier"> => ({
    extensionType: "subjectKeyIdentifier",
    keyIdentifier: toUpperHex(readSubjectKeyId(value)),
  }),

  // Key Usage (2.5.29.15)
  "2.5.29.15": (value): Parsed<"keyUsage"> | undefined => {
    const bits = expectTag(value, BIT_STRING);
    const usages = readBits(bits, KEY_USAGE_FLAGS);
    if (contents(bits).length === 1) {
      return undefined; // an empty BIT STRING: nothing to show
    }
    return { extensionType: "keyUsage", usages };
  },

  // Private Key Usage Period (2.5.29.16): [0] / [1] IMPLICIT GeneralizedTime, both OPTIONAL
  "2.5.29.16": (value): Parsed<"privateKeyUsagePeriod"> => {
    const period = new DerReader(value);
    const time = (block: BaseBlock) => timeFromBlock(asUniversal(block, GENERALIZED_TIME));
    const notBefore = period.optional(context(0), time);
    const notAfter = period.optional(context(1), time);
    period.end();
    return { extensionType: "privateKeyUsagePeriod", notBefore, notAfter };
  },

  // Subject Alternative Name (2.5.29.17)
  "2.5.29.17": (value): Parsed<"subjectAltName"> => ({
    extensionType: "subjectAltName",
    names: readGeneralNames(value),
  }),

  // Issuer Alternative Name (2.5.29.18)
  "2.5.29.18": (value): Parsed<"issuerAltName"> => ({
    extensionType: "issuerAltName",
    names: readGeneralNames(value),
  }),

  // Basic Constraints (2.5.29.19)
  "2.5.29.19": (value): Parsed<"basicConstraints"> => {
    const bc = new DerReader(value);
    const cA = bc.optional(BOOLEAN, readBoolean) ?? false;
    const pathLenConstraint = bc.optional(INTEGER, readInteger);
    bc.end();
    return { extensionType: "basicConstraints", cA, pathLenConstraint };
  },

  // CRL Number (2.5.29.20)
  "2.5.29.20": (value): Parsed<"cRLNumber"> => ({
    extensionType: "cRLNumber",
    number: readCRLInteger(value).toString(),
  }),

  // CRL Reason (2.5.29.21) - CRL entry extension
  "2.5.29.21": (value): Parsed<"cRLReason"> => {
    const code = readInteger(expectTag(value, ENUMERATED));
    return {
      extensionType: "cRLReason",
      code,
      name: CRL_REASON_CODES[code] ?? `reason_${code}`,
    };
  },

  // Hold Instruction Code (2.5.29.23) - CRL entry extension
  "2.5.29.23": (value): Parsed<"holdInstructionCode"> => ({
    extensionType: "holdInstructionCode",
    instruction: buildObjectIdentifier(
      readOid(expectTag(value, OBJECT_IDENTIFIER)),
      HOLD_INSTRUCTION_NAMES
    ),
  }),

  // Invalidity Date (2.5.29.24) - CRL entry extension
  "2.5.29.24": (value): Parsed<"invalidityDate"> => ({
    extensionType: "invalidityDate",
    date: timeFromBlock(expectTag(value, GENERALIZED_TIME)),
  }),

  // Delta CRL Indicator (2.5.29.27)
  "2.5.29.27": (value): Parsed<"deltaCRLIndicator"> => ({
    extensionType: "deltaCRLIndicator",
    baseCRLNumber: readCRLInteger(value).toString(),
  }),

  // Issuing Distribution Point (2.5.29.28)
  "2.5.29.28": (value): Parsed<"issuingDistributionPoint"> => {
    const idp = new DerReader(value);
    const flag = (num: number) => idp.optional(context(num), readBoolean) ?? false;
    const distributionPoint = idp.optional(context(0), readDistributionPointName);
    const onlyContainsUserCerts = flag(1);
    const onlyContainsCACerts = flag(2);
    const onlySomeReasons = idp.optional(context(3), readReasons);
    const indirectCRL = flag(4);
    const onlyContainsAttributeCerts = flag(5);
    idp.end();
    return {
      extensionType: "issuingDistributionPoint",
      distributionPoint,
      onlyContainsUserCerts,
      onlyContainsCACerts,
      onlySomeReasons,
      indirectCRL,
      onlyContainsAttributeCerts,
    };
  },

  // Certificate Issuer (2.5.29.29) - CRL entry extension
  "2.5.29.29": (value): Parsed<"certificateIssuer"> => ({
    extensionType: "certificateIssuer",
    names: readGeneralNames(value),
  }),

  // Name Constraints (2.5.29.30)
  "2.5.29.30": (value): Parsed<"nameConstraints"> => {
    const constraints = new DerReader(value);
    const permitted = constraints.optional(context(0));
    const excluded = constraints.optional(context(1));
    constraints.end();
    return {
      extensionType: "nameConstraints",
      permittedSubtrees: permitted && sequenceOf(permitted, context(0)).map(readGeneralSubtree),
      excludedSubtrees: excluded && sequenceOf(excluded, context(1)).map(readGeneralSubtree),
    };
  },

  // CRL Distribution Points (2.5.29.31)
  "2.5.29.31": (value): Parsed<"cRLDistributionPoints"> => ({
    extensionType: "cRLDistributionPoints",
    distributionPoints: readDistributionPoints(value),
  }),

  // Certificate Policies (2.5.29.32)
  "2.5.29.32": (value): Parsed<"certificatePolicies"> => ({
    extensionType: "certificatePolicies",
    policies: readPolicies(value),
  }),

  // Policy Mappings (2.5.29.33)
  "2.5.29.33": (value): Parsed<"policyMappings"> => ({
    extensionType: "policyMappings",
    mappings: sequenceOf(value).map((block) => {
      const mapping = new DerReader(block);
      const issuer = readOid(mapping.read(OBJECT_IDENTIFIER));
      const subject = readOid(mapping.read(OBJECT_IDENTIFIER));
      mapping.end();
      return {
        issuerDomainPolicy: buildObjectIdentifier(issuer, CERTIFICATE_POLICY_NAMES),
        subjectDomainPolicy: buildObjectIdentifier(subject, CERTIFICATE_POLICY_NAMES),
      };
    }),
  }),

  // Authority Key Identifier (2.5.29.35)
  "2.5.29.35": (value): Parsed<"authorityKeyIdentifier"> => {
    const { keyIdentifier, names, serial } = readAuthorityKeyId(value);
    return {
      extensionType: "authorityKeyIdentifier",
      keyIdentifier: keyIdentifier && toUpperHex(keyIdentifier),
      authorityCertIssuer: names?.map(readGeneralName),
      authorityCertSerialNumber: serial && toUpperHex(serial),
    };
  },

  // Policy Constraints (2.5.29.36)
  "2.5.29.36": (value): Parsed<"policyConstraints"> => {
    const constraints = new DerReader(value);
    const requireExplicitPolicy = constraints.optional(context(0), readInteger);
    const inhibitPolicyMapping = constraints.optional(context(1), readInteger);
    constraints.end();
    return { extensionType: "policyConstraints", requireExplicitPolicy, inhibitPolicyMapping };
  },

  // Extended Key Usage (2.5.29.37)
  "2.5.29.37": (value): Parsed<"extendedKeyUsage"> => ({
    extensionType: "extendedKeyUsage",
    purposes: sequenceOf(value).map((block) =>
      buildObjectIdentifier(readOid(expectTag(block, OBJECT_IDENTIFIER)), EKU_NAMES)
    ),
  }),

  // Freshest CRL (2.5.29.46)
  "2.5.29.46": (value): Parsed<"freshestCRL"> => ({
    extensionType: "freshestCRL",
    distributionPoints: readDistributionPoints(value),
  }),

  // Inhibit anyPolicy (2.5.29.54)
  "2.5.29.54": (value): Parsed<"inhibitAnyPolicy"> => ({
    extensionType: "inhibitAnyPolicy",
    skipCerts: readInteger(expectTag(value, INTEGER)),
  }),

  // Expired Certificates on CRL (2.5.29.60)
  "2.5.29.60": (value): Parsed<"expiredCertsOnCRL"> => ({
    extensionType: "expiredCertsOnCRL",
    date: timeFromBlock(expectTag(value, GENERALIZED_TIME)),
  }),

  // Authority Information Access (1.3.6.1.5.5.7.1.1)
  "1.3.6.1.5.5.7.1.1": (value): Parsed<"authorityInfoAccess"> => ({
    extensionType: "authorityInfoAccess",
    accessDescriptions: readAccessDescriptions(value),
  }),

  // Qualified Certificate Statements (1.3.6.1.5.5.7.1.3)
  "1.3.6.1.5.5.7.1.3": (value): Parsed<"qcStatements"> => ({
    extensionType: "qcStatements",
    // QCStatements ::= SEQUENCE OF QCStatement, with no SIZE (RFC 3739 §3.2.6).
    statements: sequenceOf(value, SEQUENCE, 0).map((block) => {
      const statement = new DerReader(block);
      const statementId = readOid(statement.read(OBJECT_IDENTIFIER));
      const info = statement.optional();
      statement.end();
      return {
        statementId: buildObjectIdentifier(statementId, QC_STATEMENT_NAMES),
        rawHex: info ? blockHex(info) : "",
      };
    }),
  }),

  // Subject Information Access (1.3.6.1.5.5.7.1.11)
  "1.3.6.1.5.5.7.1.11": (value): Parsed<"subjectInfoAccess"> => ({
    extensionType: "subjectInfoAccess",
    accessDescriptions: readAccessDescriptions(value),
  }),

  // TLS Feature (1.3.6.1.5.5.7.1.24)
  "1.3.6.1.5.5.7.1.24": (value): Parsed<"tlsFeature"> => ({
    extensionType: "tlsFeature",
    features: sequenceOf(value, SEQUENCE, 0).map((block) => {
      const code = readInteger(expectTag(block, INTEGER));
      return { code, name: TLS_FEATURE_NAMES[code] ?? null };
    }),
  }),

  // OCSP No Check (1.3.6.1.5.5.7.48.1.5)
  "1.3.6.1.5.5.7.48.1.5": (value): Parsed<"ocspNoCheck"> => {
    if (contents(expectTag(value, NULL)).length > 0) {
      throw new Error("Invalid NULL");
    }
    return { extensionType: "ocspNoCheck" };
  },

  // Signed Certificate Timestamp List (1.3.6.1.4.1.11129.2.4.2). PKIjs does not fail on truncated
  // TLS data or on an SCT version it does not know: it leaves the defaults (no version, an empty
  // logID, timestamp 0, no signature), and it reads a last SCT longer than the list as a short one.
  // The length prefixes must fill the list exactly and every SCT must have been read whole (RFC
  // 6962 §3.2: v1 is 0, a 32-octet LogID, a signature), or the list is an error instead of
  // invented SCTs.
  "1.3.6.1.4.1.11129.2.4.2": (value): Parsed<"signedCertificateTimestampList"> => {
    const list = expectTag(value, OCTET_STRING);
    checkSctFraming(contents(list));
    return {
      extensionType: "signedCertificateTimestampList",
      timestamps: new pkijs.SignedCertificateTimestampList({ schema: list }).timestamps.map(
        readSct
      ),
    };
  },

  // Netscape Certificate Type (2.16.840.1.113730.1.1)
  "2.16.840.1.113730.1.1": (value): Parsed<"netscapeCertType"> => {
    const bits = expectTag(value, BIT_STRING);
    return { extensionType: "netscapeCertType", flags: readBits(bits, NETSCAPE_CERT_TYPE_FLAGS) };
  },

  // Netscape Comment (2.16.840.1.113730.1.13)
  "2.16.840.1.113730.1.13": (value): Parsed<"netscapeComment"> => ({
    extensionType: "netscapeComment",
    comment: readAscii(expectTag(value, IA5_STRING)),
  }),

  // Microsoft Certificate Template Name v1 (1.3.6.1.4.1.311.20.2)
  "1.3.6.1.4.1.311.20.2": (value): Parsed<"msCertificateTemplateName"> => ({
    extensionType: "msCertificateTemplateName",
    name: readText(value),
  }),

  // Microsoft CA Version (1.3.6.1.4.1.311.21.1)
  "1.3.6.1.4.1.311.21.1": (value): Parsed<"msCaVersion"> => {
    // The key index in the high, the certificate index in the low 16 bits.
    const version = readInteger(expectTag(value, INTEGER));
    if (version < 0 || version > 0xffffffff) {
      throw new Error("Invalid CA version");
    }
    return {
      extensionType: "msCaVersion",
      certificateIndex: version % 0x10000,
      keyIndex: Math.floor(version / 0x10000),
    };
  },

  // Microsoft Previous CA Certificate Hash (1.3.6.1.4.1.311.21.2)
  "1.3.6.1.4.1.311.21.2": (value): Parsed<"msPreviousCaCertificateHash"> => ({
    extensionType: "msPreviousCaCertificateHash",
    hash: toUpperHex(contents(expectTag(value, OCTET_STRING))),
  }),

  // Microsoft CRL Virtual Base (1.3.6.1.4.1.311.21.3)
  "1.3.6.1.4.1.311.21.3": (value): Parsed<"msCrlVirtualBase"> => ({
    extensionType: "msCrlVirtualBase",
    number: readCRLInteger(value).toString(),
  }),

  // Microsoft Next CRL Publish (1.3.6.1.4.1.311.21.4)
  "1.3.6.1.4.1.311.21.4": (value): Parsed<"msCrlNextPublish"> => ({
    extensionType: "msCrlNextPublish",
    date: timeFromBlock(value),
  }),

  // Microsoft Certificate Template Information v2 (1.3.6.1.4.1.311.21.7)
  "1.3.6.1.4.1.311.21.7": (value): Parsed<"msCertificateTemplate"> => {
    const template = new DerReader(value);
    const templateId = buildObjectIdentifier(readOid(template.read(OBJECT_IDENTIFIER)));
    const majorVersion = template.optional(INTEGER, readInteger);
    const minorVersion = template.optional(INTEGER, readInteger);
    template.end();
    return { extensionType: "msCertificateTemplate", templateId, majorVersion, minorVersion };
  },

  // Microsoft Application Policies (1.3.6.1.4.1.311.21.10)
  "1.3.6.1.4.1.311.21.10": (value): Parsed<"msApplicationPolicies"> => ({
    extensionType: "msApplicationPolicies",
    policies: readPolicies(value, EKU_NAMES),
  }),

  // Microsoft CRL Self CDP (1.3.6.1.4.1.311.21.14): same syntax as CRL Distribution Points
  "1.3.6.1.4.1.311.21.14": (value): Parsed<"msCrlSelfCdp"> => ({
    extensionType: "msCrlSelfCdp",
    distributionPoints: readDistributionPoints(value),
  }),

  // Microsoft NTDS CA Security Extension (1.3.6.1.4.1.311.25.2): SEQUENCE { otherName }, whose
  // value is the SID text in an OCTET STRING
  "1.3.6.1.4.1.311.25.2": (value): Parsed<"msNtdsCaSecurity"> => {
    const sequence = new DerReader(value);
    const { inner } = readOtherNameParts(sequence.read(context(0)));
    sequence.end();
    const sid = readAscii(expectTag(inner, OCTET_STRING));
    if (!/^S-1-[0-9-]+$/.test(sid)) {
      throw new Error("Invalid SID");
    }
    return { extensionType: "msNtdsCaSecurity", sid };
  },
} satisfies Record<string, ExtensionParser>;

// Every member of the API union has a parser: a missing one names itself in a compile error.
type Decoded = NonNullable<ReturnType<(typeof EXTENSION_PARSERS)[keyof typeof EXTENSION_PARSERS]>>;
type Undecoded = Exclude<ExtensionType, Decoded["extensionType"]>;
const decodesEveryType: [Undecoded] extends [never] ? true : Undecoded = true;
void decodesEveryType;

const PARSER_BY_OID: Readonly<Record<string, ExtensionParser | undefined>> = EXTENSION_PARSERS;
