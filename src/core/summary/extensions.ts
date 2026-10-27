// Extension details are a best-effort projection, not another upload validator. Use PKIjs
// models where they preserve the data correctly; keep small readers for unsupported formats
// and known model defects. Unreadable values retain their raw bytes and ASN.1 dump.
import { Integer } from "asn1js";
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
import { plainExtension, readAuthorityKeyId, readSubjectKeyId } from "../pki/extensions.ts";
import type { PlainExtension } from "../pki/extensions.ts";
import {
  BIT_STRING,
  ENUMERATED,
  GENERALIZED_TIME,
  IA5_STRING,
  INTEGER,
  NULL,
  OBJECT_IDENTIFIER,
  OCTET_STRING,
  SEQUENCE,
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
  readOne,
  readInteger,
  readOid,
  sequenceOf,
} from "../pki/der.ts";
import {
  blockHex,
  displayText,
  dumpAsn1,
  integerNumber,
  readStrictTime,
  stringOf,
} from "../pki/asn1.ts";
import { messageOf } from "../pki/errors.ts";
import { toUpperHex } from "../digest.ts";
import type {
  AccessDescription,
  DistributionPoint,
  Extension,
  Extensions,
  GeneralSubtree,
  ParsedExtensionValue,
  PolicyInformation,
  PolicyQualifier,
  Time,
  UserNotice,
} from "./schemas.ts";
import { buildObjectIdentifier, isBlock } from "./primitives.ts";
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
    result.parsed = EXTENSION_PARSERS[ext.extnID]?.(readOne(bytes));
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
  return { distributionPoint, reasons, cRLIssuer };
}

/** CRLDistributionPoints ::= SEQUENCE SIZE (1..MAX) OF DistributionPoint (also Freshest CRL). */
const readDistributionPoints = (root: BaseBlock) => sequenceOf(root).map(readDistributionPoint);

/** AIA / SIA: preserve the original name blocks (PKIjs GeneralName mutates their tags). */
function readAccessDescriptions(root: BaseBlock): AccessDescription[] {
  return sequenceOf(root).map((block) => {
    const access = new DerReader(block);
    const accessMethod = buildObjectIdentifier(
      readOid(access.read(OBJECT_IDENTIFIER)),
      ACCESS_METHOD_NAMES
    );
    return { accessMethod, accessLocation: readGeneralName(access.any()) };
  });
}

/** GeneralSubtree ::= SEQUENCE { base, minimum [0] DEFAULT 0, maximum [1] OPTIONAL } (IMPLICIT). */
function readGeneralSubtree(block: BaseBlock): GeneralSubtree {
  const subtree = new DerReader(block);
  const base = readGeneralName(subtree.any());
  const minimum = subtree.optional(context(0), readInteger) ?? 0;
  const maximum = subtree.optional(context(1), readInteger);
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
  const text = explicitText && readText(explicitText);
  if (!reference) {
    return { explicitText: text };
  }
  const ref = new DerReader(reference);
  const organization = readText(ref.any());
  const numbers = sequenceOf(ref.read(SEQUENCE), SEQUENCE, 0);
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

function policyQualifier(info: pkijs.PolicyQualifierInfo): PolicyQualifier {
  const qualifier: unknown = info.qualifier;
  if (!isBlock(qualifier)) {
    throw new Error("Missing policy qualifier");
  }
  return {
    qualifierId: buildObjectIdentifier(info.policyQualifierId, POLICY_QUALIFIER_NAMES),
    rawHex: blockHex(qualifier),
    ...readQualifierValue(info.policyQualifierId, qualifier),
  };
}

function readPolicies(root: BaseBlock, names = CERTIFICATE_POLICY_NAMES): PolicyInformation[] {
  return new pkijs.CertificatePolicies({ schema: root }).certificatePolicies.map((policy) => ({
    policyIdentifier: buildObjectIdentifier(policy.policyIdentifier, names),
    policyQualifiers: policy.policyQualifiers?.map(policyQualifier),
  }));
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

/** A decoder of one OID, after the bytes have been read as exactly one ASN.1 value. */
type ExtensionParser = (value: BaseBlock) => ParsedExtensionValue | undefined;

const EXTENSION_PARSERS: Record<string, ExtensionParser | undefined> = {
  // Subject Directory Attributes (2.5.29.9): SEQUENCE OF Attribute { type, values SET OF ANY }
  "2.5.29.9": (value) => ({
    extensionType: "subjectDirectoryAttributes",
    attributes: new pkijs.SubjectDirectoryAttributes({ schema: value }).attributes.map(
      (attribute) => ({
        type: buildObjectIdentifier(attribute.type),
        values: attribute.values.map(displayText),
      })
    ),
  }),

  // Subject Key Identifier (2.5.29.14)
  "2.5.29.14": (value) => ({
    extensionType: "subjectKeyIdentifier",
    keyIdentifier: toUpperHex(readSubjectKeyId(value)),
  }),

  // Key Usage (2.5.29.15)
  "2.5.29.15": (value) => {
    const bits = expectTag(value, BIT_STRING);
    const usages = readBits(bits, KEY_USAGE_FLAGS);
    if (contents(bits).length === 1) {
      return undefined; // an empty BIT STRING: nothing to show
    }
    return { extensionType: "keyUsage", usages };
  },

  // Private Key Usage Period (2.5.29.16): [0] / [1] IMPLICIT GeneralizedTime, both OPTIONAL
  "2.5.29.16": (value) => {
    const period = new DerReader(value);
    const time = (block: BaseBlock) => timeFromBlock(asUniversal(block, GENERALIZED_TIME));
    const notBefore = period.optional(context(0), time);
    const notAfter = period.optional(context(1), time);
    return { extensionType: "privateKeyUsagePeriod", notBefore, notAfter };
  },

  // Subject Alternative Name (2.5.29.17)
  "2.5.29.17": (value) => ({
    extensionType: "subjectAltName",
    names: readGeneralNames(value),
  }),

  // Issuer Alternative Name (2.5.29.18)
  "2.5.29.18": (value) => ({
    extensionType: "issuerAltName",
    names: readGeneralNames(value),
  }),

  // Basic Constraints (2.5.29.19)
  "2.5.29.19": (value) => {
    const { cA, pathLenConstraint } = new pkijs.BasicConstraints({ schema: value });
    return {
      extensionType: "basicConstraints",
      cA,
      // The model leaves large values as Integer; never round them or use valueDec.
      pathLenConstraint:
        pathLenConstraint instanceof Integer ? integerNumber(pathLenConstraint) : pathLenConstraint,
    };
  },

  // CRL Number (2.5.29.20)
  "2.5.29.20": (value) => ({
    extensionType: "cRLNumber",
    number: readBigInt(expectTag(value, INTEGER)).toString(),
  }),

  // CRL Reason (2.5.29.21) - CRL entry extension
  "2.5.29.21": (value) => {
    const code = readInteger(expectTag(value, ENUMERATED));
    return {
      extensionType: "cRLReason",
      code,
      name: CRL_REASON_CODES[code] ?? `reason_${code}`,
    };
  },

  // Hold Instruction Code (2.5.29.23) - CRL entry extension
  "2.5.29.23": (value) => ({
    extensionType: "holdInstructionCode",
    instruction: buildObjectIdentifier(
      readOid(expectTag(value, OBJECT_IDENTIFIER)),
      HOLD_INSTRUCTION_NAMES
    ),
  }),

  // Invalidity Date (2.5.29.24) - CRL entry extension
  "2.5.29.24": (value) => ({
    extensionType: "invalidityDate",
    date: timeFromBlock(expectTag(value, GENERALIZED_TIME)),
  }),

  // Delta CRL Indicator (2.5.29.27)
  "2.5.29.27": (value) => ({
    extensionType: "deltaCRLIndicator",
    baseCRLNumber: readBigInt(expectTag(value, INTEGER)).toString(),
  }),

  // Issuing Distribution Point (2.5.29.28)
  "2.5.29.28": (value) => {
    const idp = new DerReader(value);
    const flag = (num: number) => idp.optional(context(num), readBoolean) ?? false;
    const distributionPoint = idp.optional(context(0), readDistributionPointName);
    const onlyContainsUserCerts = flag(1);
    const onlyContainsCACerts = flag(2);
    const onlySomeReasons = idp.optional(context(3), readReasons);
    const indirectCRL = flag(4);
    const onlyContainsAttributeCerts = flag(5);
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
  "2.5.29.29": (value) => ({
    extensionType: "certificateIssuer",
    names: readGeneralNames(value),
  }),

  // Name Constraints (2.5.29.30)
  "2.5.29.30": (value) => {
    const constraints = new DerReader(value);
    const permitted = constraints.optional(context(0));
    const excluded = constraints.optional(context(1));
    return {
      extensionType: "nameConstraints",
      permittedSubtrees: permitted && sequenceOf(permitted, context(0)).map(readGeneralSubtree),
      excludedSubtrees: excluded && sequenceOf(excluded, context(1)).map(readGeneralSubtree),
    };
  },

  // CRL Distribution Points (2.5.29.31)
  "2.5.29.31": (value) => ({
    extensionType: "cRLDistributionPoints",
    distributionPoints: readDistributionPoints(value),
  }),

  // Certificate Policies (2.5.29.32)
  "2.5.29.32": (value) => ({
    extensionType: "certificatePolicies",
    policies: readPolicies(value),
  }),

  // Policy Mappings (2.5.29.33)
  "2.5.29.33": (value) => ({
    extensionType: "policyMappings",
    mappings: new pkijs.PolicyMappings({ schema: value }).mappings.map((mapping) => ({
      issuerDomainPolicy: buildObjectIdentifier(
        mapping.issuerDomainPolicy,
        CERTIFICATE_POLICY_NAMES
      ),
      subjectDomainPolicy: buildObjectIdentifier(
        mapping.subjectDomainPolicy,
        CERTIFICATE_POLICY_NAMES
      ),
    })),
  }),

  // Authority Key Identifier (2.5.29.35)
  "2.5.29.35": (value) => {
    const { keyIdentifier, names, serial } = readAuthorityKeyId(value);
    return {
      extensionType: "authorityKeyIdentifier",
      keyIdentifier: keyIdentifier && toUpperHex(keyIdentifier),
      authorityCertIssuer: names?.map(readGeneralName),
      authorityCertSerialNumber: serial && toUpperHex(serial),
    };
  },

  // Policy Constraints (2.5.29.36)
  "2.5.29.36": (value) => {
    const constraints = new DerReader(value);
    const requireExplicitPolicy = constraints.optional(context(0), readInteger);
    const inhibitPolicyMapping = constraints.optional(context(1), readInteger);
    return { extensionType: "policyConstraints", requireExplicitPolicy, inhibitPolicyMapping };
  },

  // Extended Key Usage (2.5.29.37)
  "2.5.29.37": (value) => ({
    extensionType: "extendedKeyUsage",
    purposes: new pkijs.ExtKeyUsage({ schema: value }).keyPurposes.map((oid) =>
      buildObjectIdentifier(oid, EKU_NAMES)
    ),
  }),

  // Freshest CRL (2.5.29.46)
  "2.5.29.46": (value) => ({
    extensionType: "freshestCRL",
    distributionPoints: readDistributionPoints(value),
  }),

  // Inhibit anyPolicy (2.5.29.54)
  "2.5.29.54": (value) => ({
    extensionType: "inhibitAnyPolicy",
    skipCerts: readInteger(expectTag(value, INTEGER)),
  }),

  // Expired Certificates on CRL (2.5.29.60)
  "2.5.29.60": (value) => ({
    extensionType: "expiredCertsOnCRL",
    date: timeFromBlock(expectTag(value, GENERALIZED_TIME)),
  }),

  // Authority Information Access (1.3.6.1.5.5.7.1.1)
  "1.3.6.1.5.5.7.1.1": (value) => ({
    extensionType: "authorityInfoAccess",
    accessDescriptions: readAccessDescriptions(value),
  }),

  // Qualified Certificate Statements (1.3.6.1.5.5.7.1.3)
  "1.3.6.1.5.5.7.1.3": (value) => ({
    extensionType: "qcStatements",
    statements: sequenceOf(value, SEQUENCE, 0).map((block) => {
      const statement = new pkijs.QCStatement({ schema: block });
      const info: unknown = statement.type;
      return {
        statementId: buildObjectIdentifier(statement.id, QC_STATEMENT_NAMES),
        rawHex: isBlock(info) ? blockHex(info) : "",
      };
    }),
  }),

  // Subject Information Access (1.3.6.1.5.5.7.1.11)
  "1.3.6.1.5.5.7.1.11": (value) => ({
    extensionType: "subjectInfoAccess",
    accessDescriptions: readAccessDescriptions(value),
  }),

  // TLS Feature (1.3.6.1.5.5.7.1.24)
  "1.3.6.1.5.5.7.1.24": (value) => ({
    extensionType: "tlsFeature",
    features: sequenceOf(value, SEQUENCE, 0).map((block) => {
      const code = readInteger(expectTag(block, INTEGER));
      return { code, name: TLS_FEATURE_NAMES[code] ?? null };
    }),
  }),

  // OCSP No Check (1.3.6.1.5.5.7.48.1.5)
  "1.3.6.1.5.5.7.48.1.5": (value) => {
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
  "1.3.6.1.4.1.11129.2.4.2": (value) => {
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
  "2.16.840.1.113730.1.1": (value) => {
    const bits = expectTag(value, BIT_STRING);
    return { extensionType: "netscapeCertType", flags: readBits(bits, NETSCAPE_CERT_TYPE_FLAGS) };
  },

  // Netscape Comment (2.16.840.1.113730.1.13)
  "2.16.840.1.113730.1.13": (value) => ({
    extensionType: "netscapeComment",
    comment: readAscii(expectTag(value, IA5_STRING)),
  }),

  // Microsoft Certificate Template Name v1 (1.3.6.1.4.1.311.20.2)
  "1.3.6.1.4.1.311.20.2": (value) => ({
    extensionType: "msCertificateTemplateName",
    name: readText(value),
  }),

  // Microsoft CA Version (1.3.6.1.4.1.311.21.1)
  "1.3.6.1.4.1.311.21.1": (value) => {
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
  "1.3.6.1.4.1.311.21.2": (value) => ({
    extensionType: "msPreviousCaCertificateHash",
    hash: toUpperHex(contents(expectTag(value, OCTET_STRING))),
  }),

  // Microsoft CRL Virtual Base (1.3.6.1.4.1.311.21.3)
  "1.3.6.1.4.1.311.21.3": (value) => ({
    extensionType: "msCrlVirtualBase",
    number: readBigInt(expectTag(value, INTEGER)).toString(),
  }),

  // Microsoft Next CRL Publish (1.3.6.1.4.1.311.21.4)
  "1.3.6.1.4.1.311.21.4": (value) => ({
    extensionType: "msCrlNextPublish",
    date: timeFromBlock(value),
  }),

  // Microsoft Certificate Template Information v2 (1.3.6.1.4.1.311.21.7)
  "1.3.6.1.4.1.311.21.7": (value) => {
    const template = new DerReader(value);
    const templateId = buildObjectIdentifier(readOid(template.read(OBJECT_IDENTIFIER)));
    const majorVersion = template.optional(INTEGER, readInteger);
    const minorVersion = template.optional(INTEGER, readInteger);
    return { extensionType: "msCertificateTemplate", templateId, majorVersion, minorVersion };
  },

  // Microsoft Application Policies (1.3.6.1.4.1.311.21.10)
  "1.3.6.1.4.1.311.21.10": (value) => ({
    extensionType: "msApplicationPolicies",
    policies: readPolicies(value, EKU_NAMES),
  }),

  // Microsoft CRL Self CDP (1.3.6.1.4.1.311.21.14): same syntax as CRL Distribution Points
  "1.3.6.1.4.1.311.21.14": (value) => ({
    extensionType: "msCrlSelfCdp",
    distributionPoints: readDistributionPoints(value),
  }),

  // Microsoft NTDS CA Security Extension (1.3.6.1.4.1.311.25.2): SEQUENCE { otherName }, whose
  // value is the SID text in an OCTET STRING
  "1.3.6.1.4.1.311.25.2": (value) => {
    const sequence = new DerReader(value);
    const { inner } = readOtherNameParts(sequence.read(context(0)));
    return { extensionType: "msNtdsCaSecurity", sid: readAscii(expectTag(inner, OCTET_STRING)) };
  },
};
