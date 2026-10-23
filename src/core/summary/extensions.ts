// Detail builders for X.509 extensions: one decoder per supported OID (41 extensionType values),
// a generic ASN.1 dump for the rest. Integers are read from their contents octets (asn1js's
// valueDec, which PKIjs copies, is 0 from four octets on; beyond a safe integer the extension is a
// parse error) and an SCT list must decode whole. The extensionType literals and field names are
// the contract with the UI's views. Key identifiers are uppercase hex here (for display); catalog
// summaries and ids are lowercase, so compare across endpoints only through the summary fields.
import {
  BaseBlock,
  BitString as Asn1BitString,
  Constructed,
  Enumerated,
  GeneralizedTime,
  IA5String,
  Integer,
  Null,
  ObjectIdentifier,
  OctetString,
  Primitive,
  Sequence,
} from "asn1js";
import type { UTCTime } from "asn1js";
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
  OTHER_NAME_TYPES,
  TLS_FEATURE_NAMES,
  QC_STATEMENT_NAMES,
} from "../pki/constants.ts";
import {
  readExtensionValue,
  readExtensionSchema,
  readExtensionTime,
  readCRLInteger,
} from "../pki/extensions.ts";
import { blockHex, displayText, dumpAsn1, integerNumber, readStrictTime } from "../pki/asn1.ts";
import { toHex } from "../digest.ts";
import type {
  AccessDescription,
  DistributionPoint,
  Extension,
  Extensions,
  ExtensionType,
  GeneralName,
  GeneralSubtree,
  ParsedExtensionValue,
  PolicyInformation,
  PolicyQualifier,
  Time,
  UserNotice,
} from "./schemas.ts";
import { buildObjectIdentifier, buildTime, buildName, isBlock } from "./primitives.ts";

export function buildExtensions(extensions: pkijs.Extension[] | undefined): Extensions | undefined {
  if (!extensions || extensions.length === 0) {
    return undefined;
  }

  const items: Extension[] = extensions.map(buildExtension);
  const critical = items.filter((ext) => ext.critical).length;

  return {
    count: items.length,
    critical,
    items,
  };
}

export function buildExtension(ext: pkijs.Extension): Extension {
  const extnID = buildObjectIdentifier(ext.extnID, EXTENSION_NAMES);
  const critical = ext.critical ?? false;
  const rawBytes = ext.extnValue?.valueBlock?.valueHexView ?? new Uint8Array();
  const rawHex = toHex(rawBytes).toUpperCase();
  const byteLength = rawBytes.length;

  const extnValue = { hex: rawHex, byteLength };

  // Try to parse the extension
  let parseStatus: Extension["parseStatus"] = "unsupported";
  let parsed: ParsedExtensionValue | undefined;
  let parseError: string | undefined;

  try {
    const parser = EXTENSION_PARSERS[ext.extnID];
    if (parser) {
      parsed = parser(ext);
      if (parsed) {
        parseStatus = "parsed";
      }
    }
  } catch (error) {
    parseStatus = "error";
    parseError = error instanceof Error ? error.message : String(error);
  }

  const result: Extension = {
    extnID,
    critical,
    extnValue,
    parseStatus,
    parsed,
    parseError,
  };

  if (parseStatus !== "parsed") {
    // Give readers a structural view even when no dedicated decoder exists.
    const asn1 = dumpAsn1(rawBytes);
    if (asn1) {
      result.asn1 = asn1;
    }
  }

  return result;
}

// =============================================================================
// Shared value helpers
// =============================================================================

function bitFlags(bytes: Uint8Array, unusedBits: number, names: string[]): string[] {
  const totalBits = Math.max(0, bytes.length * 8 - unusedBits);
  const flags: string[] = [];
  for (const [index, name] of names.entries()) {
    if (index >= totalBits) {
      break;
    }
    if (((bytes[index >> 3] ?? 0) & (0x80 >> (index & 7))) !== 0) {
      flags.push(name);
    }
  }
  return flags;
}

function reasonFlags(bits: Asn1BitString): string[] {
  return bitFlags(bits.valueBlock.valueHexView, bits.valueBlock.unusedBits, REASON_FLAGS);
}

function timeFromBlock(block: UTCTime | GeneralizedTime): Time {
  const strict = readStrictTime(block);
  return { iso: strict.date.toISOString(), type: strict.type, raw: strict.raw };
}

function generalizedTimeFromDate(date: Date): Time {
  return buildTime(new pkijs.Time({ type: 1, value: date }));
}

function stringOf(block: unknown): string | undefined {
  if (!(block instanceof BaseBlock)) {
    return undefined;
  }
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

// PKIjs keeps the Integer itself where asn1js could not decode it (four contents octets and more),
// a number otherwise; integerNumber reads the contents (valueDec is 0 there).
function integerValue(value: number | Integer | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? value : integerNumber(value);
}

/** An implicitly tagged INTEGER (a context-specific primitive) as a number. */
function implicitInteger(block: BaseBlock): number {
  if (!(block instanceof Primitive) || block.valueBlock.valueHexView.length === 0) {
    throw new Error("Invalid implicitly tagged INTEGER");
  }
  return integerNumber(new Integer({ valueHex: block.valueBlock.valueHexView }));
}

function formatGuid(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  const swap = (start: number, length: number) =>
    hex
      .slice(start * 2, (start + length) * 2)
      .match(/../g)
      ?.reverse()
      .join("") ?? "";
  return `${swap(0, 4)}-${swap(4, 2)}-${swap(6, 2)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// =============================================================================
// General names
// =============================================================================

const GENERAL_NAME_TYPES: Record<number, GeneralName["type"]> = {
  0: "otherName",
  1: "rfc822Name",
  2: "dNSName",
  3: "x400Address",
  4: "directoryName",
  5: "ediPartyName",
  6: "uniformResourceIdentifier",
  7: "iPAddress",
  8: "registeredID",
};

function parseOtherName(block: unknown): GeneralName {
  const result: GeneralName = { type: "otherName", value: "" };
  if (!(block instanceof Constructed)) {
    if (isBlock(block)) {
      result.rawHex = blockHex(block);
    }
    return result;
  }
  const [typeId, wrapper] = block.valueBlock.value;
  if (typeId instanceof ObjectIdentifier) {
    result.typeOid = typeId.valueBlock.toString();
    const typeName = OTHER_NAME_TYPES[result.typeOid];
    if (typeName) {
      result.typeName = typeName;
    }
  }
  const inner = wrapper instanceof Constructed ? wrapper.valueBlock.value[0] : undefined;
  if (!(inner instanceof BaseBlock)) {
    result.rawHex = blockHex(block);
    return result;
  }
  result.rawHex = blockHex(inner);
  const text = stringOf(inner);
  if (text !== undefined) {
    result.value = text;
  } else if (
    result.typeOid === "1.3.6.1.4.1.311.25.1" &&
    inner instanceof OctetString &&
    inner.valueBlock.valueHexView.length === 16
  ) {
    result.value = formatGuid(inner.valueBlock.valueHexView);
  } else {
    result.value = displayText(inner);
  }
  return result;
}

function formatIPv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".");
}

function formatIPv6(bytes: Uint8Array): string {
  const segments: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    segments.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  // Find longest run of zeros
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < segments.length;) {
    if (segments[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < segments.length && segments[j] === "0") {
      j++;
    }
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestLength > 1) {
    segments.splice(bestStart, bestLength, "");
    if (bestStart === 0) {
      segments.unshift("");
    }
    if (bestStart + bestLength === 8) {
      segments.push("");
    }
  }
  return segments.join(":");
}

function formatIpAddress(bytes: Uint8Array): string | undefined {
  if (bytes.length === 4) {
    return formatIPv4(bytes);
  }
  if (bytes.length === 16) {
    return formatIPv6(bytes);
  }
  return undefined;
}

function prefixLength(mask: Uint8Array): number | undefined {
  let length = 0;
  let sawZero = false;
  for (const byte of mask) {
    for (let bit = 7; bit >= 0; bit--) {
      const set = (byte & (1 << bit)) !== 0;
      if (set && sawZero) {
        return undefined;
      }
      if (set) {
        length++;
      } else {
        sawZero = true;
      }
    }
  }
  return length;
}

/** iPAddress is 4/16 bytes in alternative names and 8/32 bytes (address + mask) in constraints. */
function formatIpGeneralName(bytes: Uint8Array): { value: string; rawHex?: string } {
  const plain = formatIpAddress(bytes);
  if (plain) {
    return { value: plain };
  }
  if (bytes.length === 8 || bytes.length === 32) {
    const half = bytes.length / 2;
    const address = formatIpAddress(bytes.subarray(0, half)) ?? "";
    const mask = bytes.subarray(half);
    const prefix = prefixLength(mask);
    return {
      value: prefix === undefined ? `${address}/${formatIpAddress(mask)}` : `${address}/${prefix}`,
    };
  }
  const hex = toHex(bytes).toUpperCase();
  return { value: hex, rawHex: hex };
}

function parseGeneralName(gn: pkijs.GeneralName): GeneralName {
  const type = GENERAL_NAME_TYPES[gn.type] ?? "otherName";
  const value: unknown = gn.value;

  switch (type) {
    case "otherName":
      return parseOtherName(value);
    case "rfc822Name":
    case "dNSName":
    case "uniformResourceIdentifier":
      return { type, value: typeof value === "string" ? value : "" };
    case "directoryName":
      return {
        type,
        value: value instanceof pkijs.RelativeDistinguishedNames ? buildName(value).rfc4514 : "",
      };
    case "iPAddress": {
      const bytes = value instanceof OctetString ? value.valueBlock.valueHexView : new Uint8Array();
      return { type, ...formatIpGeneralName(bytes) };
    }
    case "registeredID": {
      const oid = typeof value === "string" ? value : "";
      return { type, value: oid };
    }
    default:
      // x400Address and ediPartyName keep their DER; there is no useful text form.
      return { type, value: "", rawHex: isBlock(value) ? blockHex(value) : undefined };
  }
}

function parseGeneralNames(names: pkijs.GeneralName[] | undefined): GeneralName[] {
  return (names ?? []).map(parseGeneralName);
}

function buildDistributionPointName(
  name: pkijs.GeneralName[] | pkijs.RelativeDistinguishedNames | undefined
): DistributionPoint["distributionPoint"] {
  if (Array.isArray(name)) {
    return { fullName: name.map(parseGeneralName) };
  }
  if (name instanceof pkijs.RelativeDistinguishedNames) {
    return {
      nameRelativeToCRLIssuer: {
        attributes: buildName(name).rdnSequence.flatMap((rdn) => rdn.attributes),
      },
    };
  }
  return undefined;
}

function buildDistributionPoint(dp: pkijs.DistributionPoint): DistributionPoint {
  return {
    distributionPoint: buildDistributionPointName(dp.distributionPoint),
    reasons: dp.reasons ? reasonFlags(dp.reasons) : undefined,
    cRLIssuer: dp.cRLIssuer ? parseGeneralNames(dp.cRLIssuer) : undefined,
  };
}

function buildDistributionPoints(points: pkijs.CRLDistributionPoints): DistributionPoint[] {
  return points.distributionPoints.map(buildDistributionPoint);
}

function buildAccessDescriptions(info: pkijs.InfoAccess): AccessDescription[] {
  return info.accessDescriptions.map((access) => ({
    accessMethod: buildObjectIdentifier(access.accessMethod, ACCESS_METHOD_NAMES),
    accessLocation: parseGeneralName(access.accessLocation),
  }));
}

function buildGeneralSubtree(subtree: pkijs.GeneralSubtree): GeneralSubtree {
  return {
    base: parseGeneralName(subtree.base),
    minimum: integerValue(subtree.minimum),
    maximum: integerValue(subtree.maximum),
  };
}

// =============================================================================
// Certificate policies
// =============================================================================

const CPS_QUALIFIER = "1.3.6.1.5.5.7.2.1";
const USER_NOTICE_QUALIFIER = "1.3.6.1.5.5.7.2.2";

function parseUserNotice(sequence: Sequence): UserNotice {
  const notice: UserNotice = {};
  for (const item of sequence.valueBlock.value) {
    if (item instanceof Sequence) {
      const [organization, numbers] = item.valueBlock.value;
      if (organization instanceof BaseBlock) {
        notice.organization = displayText(organization);
      }
      if (numbers instanceof Sequence) {
        notice.noticeNumbers = numbers.valueBlock.value
          .filter((number): number is Integer => number instanceof Integer)
          .map((number) => number.toBigInt().toString(10));
      }
    } else if (item instanceof BaseBlock) {
      notice.explicitText = displayText(item);
    }
  }
  return notice;
}

function buildPolicyQualifier(info: pkijs.PolicyQualifierInfo): PolicyQualifier {
  const qualifier: unknown = info.qualifier;
  const result: PolicyQualifier = {
    qualifierId: buildObjectIdentifier(info.policyQualifierId, POLICY_QUALIFIER_NAMES),
    rawHex: isBlock(qualifier) ? blockHex(qualifier) : "",
  };
  if (info.policyQualifierId === CPS_QUALIFIER) {
    const uri = stringOf(qualifier);
    if (uri !== undefined) {
      result.cpsUri = uri;
    }
  } else if (info.policyQualifierId === USER_NOTICE_QUALIFIER && qualifier instanceof Sequence) {
    result.userNotice = parseUserNotice(qualifier);
  }
  return result;
}

function buildPolicies(policies: pkijs.CertificatePolicies): PolicyInformation[] {
  return policies.certificatePolicies.map((policy) => ({
    policyIdentifier: buildObjectIdentifier(policy.policyIdentifier, CERTIFICATE_POLICY_NAMES),
    policyQualifiers: policy.policyQualifiers?.map(buildPolicyQualifier),
  }));
}

// =============================================================================
// Extension parsers
// =============================================================================

type ExtensionParser = (ext: pkijs.Extension) => ParsedExtensionValue | undefined;

/** The member of ParsedExtensionValue for one extensionType: the return type of its parser. */
type Parsed<K extends ExtensionType> = Extract<ParsedExtensionValue, { extensionType: K }>;

function requireSequence(ext: pkijs.Extension): Sequence {
  const schema = readExtensionSchema(ext);
  if (!(schema instanceof Sequence)) {
    throw new Error(`Invalid extension ${ext.extnID}`);
  }
  return schema;
}

function findFirst<T extends BaseBlock>(
  block: BaseBlock,
  predicate: (candidate: BaseBlock) => candidate is T
): T | undefined {
  if (predicate(block)) {
    return block;
  }
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  if (Array.isArray(value)) {
    for (const child of value) {
      if (isBlock(child)) {
        const found = findFirst(child, predicate);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

const EXTENSION_PARSERS: Record<string, ExtensionParser> = {
  // Subject Directory Attributes (2.5.29.9)
  "2.5.29.9": (ext): Parsed<"subjectDirectoryAttributes"> => ({
    extensionType: "subjectDirectoryAttributes",
    attributes: readExtensionValue(ext, pkijs.SubjectDirectoryAttributes).attributes.map(
      (attribute) => ({
        type: buildObjectIdentifier(attribute.type),
        values: attribute.values.map((value: unknown) =>
          isBlock(value) ? displayText(value) : String(value)
        ),
      })
    ),
  }),

  // Subject Key Identifier (2.5.29.14)
  "2.5.29.14": (ext): Parsed<"subjectKeyIdentifier"> => {
    const octetString = readExtensionValue(ext, OctetString);
    const keyIdentifier = toHex(octetString.valueBlock.valueHex).toUpperCase();
    return { extensionType: "subjectKeyIdentifier", keyIdentifier };
  },

  // Key Usage (2.5.29.15)
  "2.5.29.15": (ext): Parsed<"keyUsage"> | undefined => {
    const bitString = readExtensionValue(ext, Asn1BitString);
    const bytes = bitString.valueBlock.valueHexView;
    if (bytes.length === 0) {
      return undefined;
    }
    const usages = bitFlags(bytes, bitString.valueBlock.unusedBits, KEY_USAGE_FLAGS);
    const has = (flag: string) => usages.includes(flag);
    return {
      extensionType: "keyUsage",
      digitalSignature: has("digitalSignature"),
      nonRepudiation: has("nonRepudiation"),
      keyEncipherment: has("keyEncipherment"),
      dataEncipherment: has("dataEncipherment"),
      keyAgreement: has("keyAgreement"),
      keyCertSign: has("keyCertSign"),
      cRLSign: has("cRLSign"),
      encipherOnly: has("encipherOnly"),
      decipherOnly: has("decipherOnly"),
      usages,
    };
  },

  // Private Key Usage Period (2.5.29.16)
  "2.5.29.16": (ext): Parsed<"privateKeyUsagePeriod"> => {
    const period = readExtensionValue(ext, pkijs.PrivateKeyUsagePeriod);
    return {
      extensionType: "privateKeyUsagePeriod",
      notBefore: period.notBefore ? generalizedTimeFromDate(period.notBefore) : undefined,
      notAfter: period.notAfter ? generalizedTimeFromDate(period.notAfter) : undefined,
    };
  },

  // Subject Alternative Name (2.5.29.17)
  "2.5.29.17": (ext): Parsed<"subjectAltName"> => ({
    extensionType: "subjectAltName",
    names: parseGeneralNames(readExtensionValue(ext, pkijs.AltName).altNames),
  }),

  // Issuer Alternative Name (2.5.29.18)
  "2.5.29.18": (ext): Parsed<"issuerAltName"> => ({
    extensionType: "issuerAltName",
    names: parseGeneralNames(readExtensionValue(ext, pkijs.AltName).altNames),
  }),

  // Basic Constraints (2.5.29.19)
  "2.5.29.19": (ext): Parsed<"basicConstraints"> => {
    const bc = readExtensionValue(ext, pkijs.BasicConstraints);
    const rawPath: unknown = bc.pathLenConstraint;
    const pathLenConstraint =
      rawPath === undefined || rawPath === null
        ? undefined
        : typeof rawPath === "number"
          ? rawPath
          : rawPath instanceof Integer
            ? integerNumber(rawPath)
            : undefined;
    return {
      extensionType: "basicConstraints",
      cA: bc.cA ?? false,
      pathLenConstraint,
    };
  },

  // CRL Number (2.5.29.20)
  "2.5.29.20": (ext): Parsed<"cRLNumber"> => ({
    extensionType: "cRLNumber",
    number: readCRLInteger(ext).toString(),
  }),

  // CRL Reason (2.5.29.21) - CRL entry extension
  "2.5.29.21": (ext): Parsed<"cRLReason"> => {
    const code = integerNumber(readExtensionValue(ext, Enumerated));
    return {
      extensionType: "cRLReason",
      code,
      name: CRL_REASON_CODES[code] ?? `reason_${code}`,
    };
  },

  // Hold Instruction Code (2.5.29.23) - CRL entry extension
  "2.5.29.23": (ext): Parsed<"holdInstructionCode"> => ({
    extensionType: "holdInstructionCode",
    instruction: buildObjectIdentifier(
      readExtensionValue(ext, ObjectIdentifier).valueBlock.toString(),
      HOLD_INSTRUCTION_NAMES
    ),
  }),

  // Invalidity Date (2.5.29.24) - CRL entry extension
  "2.5.29.24": (ext): Parsed<"invalidityDate"> => ({
    extensionType: "invalidityDate",
    date: timeFromBlock(readExtensionValue(ext, GeneralizedTime)),
  }),

  // Delta CRL Indicator (2.5.29.27)
  "2.5.29.27": (ext): Parsed<"deltaCRLIndicator"> => ({
    extensionType: "deltaCRLIndicator",
    baseCRLNumber: readCRLInteger(ext).toString(),
  }),

  // Issuing Distribution Point (2.5.29.28)
  "2.5.29.28": (ext): Parsed<"issuingDistributionPoint"> => {
    const idp = readExtensionValue(ext, pkijs.IssuingDistributionPoint);
    // PKIjs folds onlySomeReasons into a lossy integer; read the bits from the DER instead.
    const reasons = requireSequence(ext).valueBlock.value.find(
      (block) => block.idBlock.tagClass === 3 && block.idBlock.tagNumber === 3
    );
    const reasonBytes = reasons instanceof Primitive ? reasons.valueBlock.valueHexView : undefined;
    return {
      extensionType: "issuingDistributionPoint",
      distributionPoint: buildDistributionPointName(idp.distributionPoint),
      onlyContainsUserCerts: idp.onlyContainsUserCerts,
      onlyContainsCACerts: idp.onlyContainsCACerts,
      onlySomeReasons:
        reasonBytes && reasonBytes.length > 0
          ? bitFlags(reasonBytes.subarray(1), reasonBytes[0] ?? 0, REASON_FLAGS)
          : undefined,
      indirectCRL: idp.indirectCRL,
      onlyContainsAttributeCerts: idp.onlyContainsAttributeCerts,
    };
  },

  // Certificate Issuer (2.5.29.29) - CRL entry extension
  "2.5.29.29": (ext): Parsed<"certificateIssuer"> => ({
    extensionType: "certificateIssuer",
    names: parseGeneralNames(readExtensionValue(ext, pkijs.GeneralNames).names),
  }),

  // Name Constraints (2.5.29.30)
  "2.5.29.30": (ext): Parsed<"nameConstraints"> => {
    const constraints = readExtensionValue(ext, pkijs.NameConstraints);
    return {
      extensionType: "nameConstraints",
      permittedSubtrees: constraints.permittedSubtrees?.map(buildGeneralSubtree),
      excludedSubtrees: constraints.excludedSubtrees?.map(buildGeneralSubtree),
    };
  },

  // CRL Distribution Points (2.5.29.31)
  "2.5.29.31": (ext): Parsed<"cRLDistributionPoints"> => ({
    extensionType: "cRLDistributionPoints",
    distributionPoints: buildDistributionPoints(
      readExtensionValue(ext, pkijs.CRLDistributionPoints)
    ),
  }),

  // Certificate Policies (2.5.29.32)
  "2.5.29.32": (ext): Parsed<"certificatePolicies"> => ({
    extensionType: "certificatePolicies",
    policies: buildPolicies(readExtensionValue(ext, pkijs.CertificatePolicies)),
  }),

  // Policy Mappings (2.5.29.33)
  "2.5.29.33": (ext): Parsed<"policyMappings"> => ({
    extensionType: "policyMappings",
    mappings: readExtensionValue(ext, pkijs.PolicyMappings).mappings.map((mapping) => ({
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
  "2.5.29.35": (ext): Parsed<"authorityKeyIdentifier"> => {
    const aki = readExtensionValue(ext, pkijs.AuthorityKeyIdentifier);
    return {
      extensionType: "authorityKeyIdentifier",
      keyIdentifier: aki.keyIdentifier
        ? toHex(aki.keyIdentifier.valueBlock.valueHexView).toUpperCase()
        : undefined,
      authorityCertIssuer: aki.authorityCertIssuer?.map(parseGeneralName),
      authorityCertSerialNumber: aki.authorityCertSerialNumber
        ? toHex(aki.authorityCertSerialNumber.valueBlock.valueHexView).toUpperCase()
        : undefined,
    };
  },

  // Policy Constraints (2.5.29.36)
  "2.5.29.36": (ext): Parsed<"policyConstraints"> => {
    // PKIjs checks the shape; its numbers are valueDec, so they are read from the fields' contents.
    readExtensionValue(ext, pkijs.PolicyConstraints);
    const fields = requireSequence(ext).valueBlock.value;
    const skipCerts = (tagNumber: number) => {
      const field = fields.find(
        (block) => block.idBlock.tagClass === 3 && block.idBlock.tagNumber === tagNumber
      );
      return field === undefined ? undefined : implicitInteger(field);
    };
    return {
      extensionType: "policyConstraints",
      requireExplicitPolicy: skipCerts(0),
      inhibitPolicyMapping: skipCerts(1),
    };
  },

  // Extended Key Usage (2.5.29.37)
  "2.5.29.37": (ext): Parsed<"extendedKeyUsage"> => ({
    extensionType: "extendedKeyUsage",
    purposes: readExtensionValue(ext, pkijs.ExtKeyUsage).keyPurposes.map((oid) =>
      buildObjectIdentifier(oid, EKU_NAMES)
    ),
  }),

  // Freshest CRL (2.5.29.46)
  "2.5.29.46": (ext): Parsed<"freshestCRL"> => ({
    extensionType: "freshestCRL",
    distributionPoints: buildDistributionPoints(
      readExtensionValue(ext, pkijs.CRLDistributionPoints)
    ),
  }),

  // Inhibit anyPolicy (2.5.29.54)
  "2.5.29.54": (ext): Parsed<"inhibitAnyPolicy"> => ({
    extensionType: "inhibitAnyPolicy",
    skipCerts: integerNumber(readExtensionValue(ext, Integer)),
  }),

  // Expired Certificates on CRL (2.5.29.60)
  "2.5.29.60": (ext): Parsed<"expiredCertsOnCRL"> => ({
    extensionType: "expiredCertsOnCRL",
    date: timeFromBlock(readExtensionValue(ext, GeneralizedTime)),
  }),

  // Authority Information Access (1.3.6.1.5.5.7.1.1)
  "1.3.6.1.5.5.7.1.1": (ext): Parsed<"authorityInfoAccess"> => ({
    extensionType: "authorityInfoAccess",
    accessDescriptions: buildAccessDescriptions(readExtensionValue(ext, pkijs.InfoAccess)),
  }),

  // Qualified Certificate Statements (1.3.6.1.5.5.7.1.3)
  "1.3.6.1.5.5.7.1.3": (ext): Parsed<"qcStatements"> => ({
    extensionType: "qcStatements",
    statements: readExtensionValue(ext, pkijs.QCStatements).values.map((statement) => {
      const type: unknown = statement.type;
      return {
        statementId: buildObjectIdentifier(statement.id, QC_STATEMENT_NAMES),
        rawHex: isBlock(type) ? blockHex(type) : "",
      };
    }),
  }),

  // Subject Information Access (1.3.6.1.5.5.7.1.11)
  "1.3.6.1.5.5.7.1.11": (ext): Parsed<"subjectInfoAccess"> => ({
    extensionType: "subjectInfoAccess",
    accessDescriptions: buildAccessDescriptions(readExtensionValue(ext, pkijs.InfoAccess)),
  }),

  // TLS Feature (1.3.6.1.5.5.7.1.24)
  "1.3.6.1.5.5.7.1.24": (ext): Parsed<"tlsFeature"> => ({
    extensionType: "tlsFeature",
    features: requireSequence(ext).valueBlock.value.map((item) => {
      if (!(item instanceof Integer)) {
        throw new Error(`Invalid TLS feature in ${ext.extnID}`);
      }
      const code = integerNumber(item);
      return { code, name: TLS_FEATURE_NAMES[code] ?? null };
    }),
  }),

  // OCSP No Check (1.3.6.1.5.5.7.48.1.5)
  "1.3.6.1.5.5.7.48.1.5": (ext): Parsed<"ocspNoCheck"> => {
    readExtensionValue(ext, Null);
    return { extensionType: "ocspNoCheck" };
  },

  // Signed Certificate Timestamp List (1.3.6.1.4.1.11129.2.4.2). PKIjs does not fail on truncated
  // TLS data or on an SCT version it does not know: it leaves the defaults (no version, an empty
  // logID, timestamp 0, no signature). Every SCT must have been read whole (RFC 6962 §3.2: v1 is
  // 0, a 32-octet LogID, a signature), or the list is an error instead of invented SCTs.
  "1.3.6.1.4.1.11129.2.4.2": (ext): Parsed<"signedCertificateTimestampList"> => ({
    extensionType: "signedCertificateTimestampList",
    timestamps: readExtensionValue(ext, pkijs.SignedCertificateTimestampList).timestamps.map(
      (sct) => {
        const signature: unknown = sct.signature;
        const signatureHex = isBlock(signature)
          ? blockHex(signature)
          : signature instanceof ArrayBuffer || ArrayBuffer.isView(signature)
            ? toHex(signature as ArrayBuffer | Uint8Array).toUpperCase()
            : "";
        // version is typed number but is undefined when the data ended before it.
        const version: unknown = sct.version;
        if (typeof version !== "number" || sct.logID.byteLength !== 32 || signatureHex === "") {
          throw new Error(`Invalid SCT in ${ext.extnID}`);
        }
        return {
          version,
          logId: toHex(sct.logID).toUpperCase(),
          timestamp: sct.timestamp.toISOString(),
          hashAlgorithm: sct.hashAlgorithm,
          signatureAlgorithm: sct.signatureAlgorithm,
          signature: signatureHex,
        };
      }
    ),
  }),

  // Netscape Certificate Type (2.16.840.1.113730.1.1)
  "2.16.840.1.113730.1.1": (ext): Parsed<"netscapeCertType"> => {
    const bits = readExtensionValue(ext, Asn1BitString);
    return {
      extensionType: "netscapeCertType",
      flags: bitFlags(
        bits.valueBlock.valueHexView,
        bits.valueBlock.unusedBits,
        NETSCAPE_CERT_TYPE_FLAGS
      ),
    };
  },

  // Netscape Comment (2.16.840.1.113730.1.13)
  "2.16.840.1.113730.1.13": (ext): Parsed<"netscapeComment"> => ({
    extensionType: "netscapeComment",
    comment: readExtensionValue(ext, IA5String).valueBlock.value,
  }),

  // Microsoft Certificate Template Name v1 (1.3.6.1.4.1.311.20.2)
  "1.3.6.1.4.1.311.20.2": (ext): Parsed<"msCertificateTemplateName"> => {
    const name = stringOf(readExtensionSchema(ext));
    if (name === undefined) {
      throw new Error(`Invalid template name in ${ext.extnID}`);
    }
    return { extensionType: "msCertificateTemplateName", name };
  },

  // Microsoft CA Version (1.3.6.1.4.1.311.21.1)
  "1.3.6.1.4.1.311.21.1": (ext): Parsed<"msCaVersion"> => {
    const version = readExtensionValue(ext, pkijs.CAVersion);
    return {
      extensionType: "msCaVersion",
      certificateIndex: version.certificateIndex,
      keyIndex: version.keyIndex,
    };
  },

  // Microsoft Previous CA Certificate Hash (1.3.6.1.4.1.311.21.2)
  "1.3.6.1.4.1.311.21.2": (ext): Parsed<"msPreviousCaCertificateHash"> => ({
    extensionType: "msPreviousCaCertificateHash",
    hash: toHex(readExtensionValue(ext, OctetString).valueBlock.valueHexView).toUpperCase(),
  }),

  // Microsoft CRL Virtual Base (1.3.6.1.4.1.311.21.3)
  "1.3.6.1.4.1.311.21.3": (ext): Parsed<"msCrlVirtualBase"> => ({
    extensionType: "msCrlVirtualBase",
    number: readCRLInteger(ext).toString(),
  }),

  // Microsoft Next CRL Publish (1.3.6.1.4.1.311.21.4)
  "1.3.6.1.4.1.311.21.4": (ext): Parsed<"msCrlNextPublish"> => ({
    extensionType: "msCrlNextPublish",
    date: timeFromBlock(readExtensionTime(ext)),
  }),

  // Microsoft Certificate Template Information v2 (1.3.6.1.4.1.311.21.7)
  "1.3.6.1.4.1.311.21.7": (ext): Parsed<"msCertificateTemplate"> => {
    const template = readExtensionValue(ext, pkijs.CertificateTemplate);
    // PKIjs's versions are valueDec: read them from the INTEGERs after the templateID.
    const [, major, minor] = requireSequence(ext).valueBlock.value;
    return {
      extensionType: "msCertificateTemplate",
      templateId: buildObjectIdentifier(template.templateID),
      majorVersion: major instanceof Integer ? integerNumber(major) : undefined,
      minorVersion: minor instanceof Integer ? integerNumber(minor) : undefined,
    };
  },

  // Microsoft Application Policies (1.3.6.1.4.1.311.21.10)
  "1.3.6.1.4.1.311.21.10": (ext): Parsed<"msApplicationPolicies"> => ({
    extensionType: "msApplicationPolicies",
    policies: buildPolicies(readExtensionValue(ext, pkijs.CertificatePolicies)).map((policy) => ({
      ...policy,
      policyIdentifier: buildObjectIdentifier(policy.policyIdentifier.oid, EKU_NAMES),
    })),
  }),

  // Microsoft CRL Self CDP (1.3.6.1.4.1.311.21.14): same syntax as CRL Distribution Points
  "1.3.6.1.4.1.311.21.14": (ext): Parsed<"msCrlSelfCdp"> => ({
    extensionType: "msCrlSelfCdp",
    distributionPoints: buildDistributionPoints(
      new pkijs.CRLDistributionPoints({ schema: requireSequence(ext) })
    ),
  }),

  // Microsoft NTDS CA Security Extension (1.3.6.1.4.1.311.25.2): OtherName carrying the SID
  "1.3.6.1.4.1.311.25.2": (ext): Parsed<"msNtdsCaSecurity"> => {
    const octets = findFirst(
      requireSequence(ext),
      (block): block is OctetString => block instanceof OctetString
    );
    if (!octets) {
      throw new Error(`Invalid SID in ${ext.extnID}`);
    }
    const sid = new TextDecoder("latin1").decode(octets.valueBlock.valueHexView);
    if (!/^S-1-[0-9-]+$/.test(sid)) {
      throw new Error(`Invalid SID in ${ext.extnID}`);
    }
    return { extensionType: "msNtdsCaSecurity", sid };
  },
};
