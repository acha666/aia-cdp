// What the UI shows for each decoded extension value: sections drawn by
// components/x509/ExtensionView.vue, each one KeyValueList of label / value rows; every value is
// one of the four kinds of utils/values.ts. A repeated element (distribution point, policy, SCT)
// is a section of its own, so its parts stay together. The texts that depend on the UI language
// come from the vue-i18n composer passed in (useI18n(), or createAppI18n().global in a test). Data
// labels (OID names) stay as the server sends them, except the access methods RFC 5280 defines,
// which the locales name.
//
// The 41 extensionType values and their fields are the contract with src/core/summary/schemas.ts:
// the switch is exhaustive, so a type added there fails to compile here until it has a case. A
// type this build does not know (a newer server) yields null, and the view falls back to the raw
// value.
import type {
  DistributionPoint,
  GeneralName,
  GeneralSubtree,
  ObjectIdentifier,
  ParsedExtensionValue,
  PolicyInformation,
  PolicyQualifier,
} from "@/client/types";
import type { I18nText } from "@/i18n";
import type en from "@/locales/en.json";
import { formatDate } from "@/utils/dates";
import { rowOf, rows } from "@/utils/values";
import type { Row, Value } from "@/utils/values";
import { formatAttribute, formatGeneralName } from "@/utils/x509";

/** One label / value list (KeyValueList); a repeated element (point, policy, SCT) gets its own. */
export type Section = Row[];

/** A label of extension.fields: one missing from en.json does not compile. */
export type FieldKey = keyof typeof en.extension.fields;

const field = (key: FieldKey, i18n: I18nText) => i18n.t(`extension.fields.${key}`);

/** The label of an access method: localized when well known (caIssuers, ocsp, …), else data. */
function accessMethod({ oid, name }: ObjectIdentifier, i18n: I18nText): string {
  const key = `extension.accessMethod.${name ?? ""}`;
  return name !== null && i18n.te(key) ? i18n.t(key) : (name ?? oid);
}

/** "name (oid)", or the OID alone when it has no known name. */
function oidText(oid: ObjectIdentifier): string {
  return oid.name ? `${oid.name} (${oid.oid})` : oid.oid;
}

/** "DNS: example.com [0–2]": the base name and, when given, its minimum / maximum. */
export function describeSubtree(subtree: GeneralSubtree, i18n: I18nText): string {
  const { minimum, maximum } = subtree;
  const base = formatGeneralName(subtree.base, i18n);
  if (minimum === 0 && maximum === undefined) {
    return base; // the default range [0–∞) says nothing
  }
  const upper = maximum === undefined ? "" : `–${String(maximum)}`;
  return `${base} [${String(minimum)}${upper}]`;
}

const names = (list: readonly GeneralName[], i18n: I18nText): Value => ({
  lines: list.map((name) => formatGeneralName(name, i18n)),
});

/** The name, reasons and CRL issuer of a distribution point (or of an IDP's scope). */
function pointRows(point: DistributionPoint, i18n: I18nText): Row[] {
  const { distributionPoint: name, reasons, cRLIssuer } = point;
  const relative = name?.nameRelativeToCRLIssuer?.attributes.map(formatAttribute).join("+");
  const row = rowOf<FieldKey>(i18n, "extension.fields");
  return rows(
    name?.fullName !== undefined && row("fullName", names(name.fullName, i18n)),
    relative !== undefined && row("nameRelativeToCRLIssuer", { lines: [relative] }),
    reasons !== undefined && row("reasons", { tags: reasons }),
    cRLIssuer !== undefined && row("crlIssuer", names(cRLIssuer, i18n))
  );
}

function qualifierRow(qualifier: PolicyQualifier, i18n: I18nText): Row {
  const { cpsUri, userNotice } = qualifier;
  if (cpsUri !== undefined) {
    return { label: field("cps", i18n), value: { lines: [cpsUri] } };
  }
  if (userNotice !== undefined) {
    const { organization, noticeNumbers, explicitText } = userNotice;
    const numbers = noticeNumbers?.length ? ` (${noticeNumbers.join(", ")})` : "";
    const lines = [organization === undefined ? "" : `${organization}${numbers}`, explicitText];
    return { label: field("userNotice", i18n), value: lines.filter(Boolean).join("\n") };
  }
  return {
    label: qualifier.qualifierId.name ?? qualifier.qualifierId.oid,
    value: { hex: qualifier.rawHex },
  };
}

/** One section per policy: its identifier, then its qualifiers. */
const policySections = (policies: readonly PolicyInformation[], i18n: I18nText) =>
  policies.map((policy) => [
    { label: field("policy", i18n), value: oidText(policy.policyIdentifier) },
    ...(policy.policyQualifiers ?? []).map((qualifier) => qualifierRow(qualifier, i18n)),
  ]);

/**
 * The sections of a decoded extension value, in display order, empty ones dropped (none: the view
 * reads "(empty)"); null for an extensionType this build does not know.
 */
export function describeExtension(value: ParsedExtensionValue, i18n: I18nText): Section[] | null {
  return sectionsOf(value, i18n)?.filter((section) => section.length > 0) ?? null;
}

function sectionsOf(value: ParsedExtensionValue, i18n: I18nText): Section[] | null {
  const row = rowOf<FieldKey>(i18n, "extension.fields");
  /** An ISO date-time in the viewer's time zone and language; N/A when absent. */
  const time = (iso: string | undefined) => formatDate(iso, i18n);
  const yesNo = (flag: boolean) => i18n.t(flag ? "common.yes" : "common.no");
  switch (value.extensionType) {
    case "basicConstraints":
      return [
        rows(
          row("ca", yesNo(value.cA)),
          value.pathLenConstraint !== undefined &&
            row("pathLength", String(value.pathLenConstraint))
        ),
      ];
    case "keyUsage":
      return [[row("usages", { tags: value.usages })]];
    case "extendedKeyUsage":
      return [[row("purposes", { tags: value.purposes.map((p) => p.name ?? p.oid) })]];
    case "tlsFeature":
      return [[row("features", { tags: value.features.map((f) => f.name ?? String(f.code)) })]];
    case "netscapeCertType":
      return [[row("certTypes", { tags: value.flags })]];
    case "subjectAltName":
    case "issuerAltName":
    case "certificateIssuer":
      return [[row("names", names(value.names, i18n))]];
    case "subjectKeyIdentifier":
      return [[row("keyId", { hex: value.keyIdentifier })]];
    case "authorityKeyIdentifier": {
      const { keyIdentifier, authorityCertIssuer, authorityCertSerialNumber } = value;
      return [
        rows(
          keyIdentifier !== undefined && row("keyId", { hex: keyIdentifier }),
          authorityCertIssuer !== undefined &&
            row("authorityCertIssuer", names(authorityCertIssuer, i18n)),
          authorityCertSerialNumber !== undefined &&
            row("authorityCertSerialNumber", { hex: authorityCertSerialNumber })
        ),
      ];
    }
    case "cRLDistributionPoints":
    case "freshestCRL":
    case "msCrlSelfCdp":
      return value.distributionPoints.map((point) => pointRows(point, i18n));
    case "authorityInfoAccess":
    case "subjectInfoAccess":
      return [
        value.accessDescriptions.map((access) => ({
          label: accessMethod(access.accessMethod, i18n),
          value: names([access.accessLocation], i18n),
        })),
      ];
    case "certificatePolicies":
    case "msApplicationPolicies":
      return policySections(value.policies, i18n);
    case "nameConstraints": {
      const subtrees = (list: readonly GeneralSubtree[]): Value => ({
        lines: list.map((subtree) => describeSubtree(subtree, i18n)),
      });
      return [
        rows(
          value.permittedSubtrees !== undefined &&
            row("permittedSubtrees", subtrees(value.permittedSubtrees)),
          value.excludedSubtrees !== undefined &&
            row("excludedSubtrees", subtrees(value.excludedSubtrees))
        ),
      ];
    }
    case "issuingDistributionPoint": {
      const flags = (
        [
          "onlyContainsUserCerts",
          "onlyContainsCACerts",
          "onlyContainsAttributeCerts",
          "indirectCRL",
        ] as const
      ).filter((key) => value[key] === true);
      const point = { distributionPoint: value.distributionPoint, reasons: value.onlySomeReasons };
      return [[...pointRows(point, i18n), ...flags.map((key) => row(key, yesNo(true)))]];
    }
    case "cRLNumber":
      return [[row("crlNumber", value.number)]];
    case "msCrlVirtualBase":
      return [[row("virtualBaseCrlNumber", value.number)]];
    case "deltaCRLIndicator":
      return [[row("baseCrlNumber", value.baseCRLNumber)]];
    case "cRLReason":
      return [[row("reason", `${value.name} (${String(value.code)})`)]];
    case "holdInstructionCode":
      return [[row("holdInstruction", oidText(value.instruction))]];
    case "invalidityDate":
      return [[row("invalidityDate", time(value.date.iso))]];
    case "expiredCertsOnCRL":
      return [[row("expiredCertsOnCRL", time(value.date.iso))]];
    case "msCrlNextPublish":
      return [[row("nextCrlPublish", time(value.date.iso))]];
    case "privateKeyUsagePeriod":
      return [
        [row("notBefore", time(value.notBefore?.iso)), row("notAfter", time(value.notAfter?.iso))],
      ];
    case "policyConstraints": {
      const keys = (["requireExplicitPolicy", "inhibitPolicyMapping"] as const).filter(
        (key) => value[key] !== undefined
      );
      return [keys.map((key) => row(key, String(value[key])))];
    }
    case "policyMappings":
      return [
        value.mappings.map((mapping) => ({
          label: oidText(mapping.issuerDomainPolicy),
          value: oidText(mapping.subjectDomainPolicy),
        })),
      ];
    case "inhibitAnyPolicy":
      return [[row("skipCerts", String(value.skipCerts))]];
    case "signedCertificateTimestampList":
      return value.timestamps.map((sct) => [
        row("logId", { hex: sct.logId }),
        row("timestamp", time(sct.timestamp)),
        row("signatureAlgorithm", `${sct.hashAlgorithm}/${sct.signatureAlgorithm}`),
      ]);
    case "ocspNoCheck":
      return [[row("ocspNoCheck", yesNo(true))]];
    case "netscapeComment":
      return [[row("comment", value.comment)]];
    case "qcStatements":
      // A statement without statementInfo has an empty value: "(empty)".
      return [
        value.statements.map((statement) => ({
          label: oidText(statement.statementId),
          value: { hex: statement.rawHex },
        })),
      ];
    case "subjectDirectoryAttributes":
      return [
        value.attributes.map((attribute) => ({
          label: oidText(attribute.type),
          value: attribute.values.join("; "),
        })),
      ];
    case "msCaVersion":
      return [
        [
          row("certificateIndex", String(value.certificateIndex)),
          row("keyIndex", String(value.keyIndex)),
        ],
      ];
    case "msCertificateTemplateName":
      return [[row("templateName", value.name)]];
    case "msCertificateTemplate":
      return [
        [
          row("templateId", oidText(value.templateId)),
          row(
            "templateVersion",
            `${String(value.majorVersion ?? 0)}.${String(value.minorVersion ?? 0)}`
          ),
        ],
      ];
    case "msPreviousCaCertificateHash":
      return [[row("previousCaCertificateHash", { hex: value.hash })]];
    case "msNtdsCaSecurity":
      return [[row("sid", value.sid)]];
    default: {
      // Compile-time exhaustiveness; at run time, a type of a newer server.
      const _exhaustive: never = value;
      void _exhaustive;
      return null;
    }
  }
}
