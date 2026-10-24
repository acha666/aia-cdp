// What the UI shows for each decoded extension value: sections drawn by
// components/x509/ExtensionView.vue, each one KeyValueList of label / value rows; every value is
// one of the four kinds of utils/values.ts. A repeated element (distribution point, policy, SCT)
// is a section of its own, so its parts stay together. The texts that depend on the UI language
// come through ExtensionContext, so the mapping is testable without a component.
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
import type en from "@/locales/en.json";
import { rows } from "@/utils/values";
import type { Row, Value } from "@/utils/values";
import { formatAttribute } from "@/utils/x509";

/** One label / value list (KeyValueList); a repeated element (point, policy, SCT) gets its own. */
export type Section = Row[];

/** A label of extension.fields: one missing from en.json does not compile. */
export type FieldKey = keyof typeof en.extension.fields;

/** The UI-language texts the sections need (useExtensionContext binds them to vue-i18n). */
export interface ExtensionContext {
  field: (key: FieldKey) => string;
  /** "URI: http://…": the name after the short label of its type (extension.generalName.*). */
  name: (name: GeneralName) => string;
  /** The label of an access method: localized when well known (caIssuers, ocsp, …), else data. */
  accessMethod: (method: ObjectIdentifier) => string;
  /** An ISO date-time in the viewer's time zone and language; N/A when absent. */
  time: (iso: string | undefined) => string;
  yesNo: (value: boolean) => string;
}

/** "name (oid)", or the OID alone when it has no known name. */
function oidText(oid: ObjectIdentifier): string {
  return oid.name ? `${oid.name} (${oid.oid})` : oid.oid;
}

/** "DNS: example.com [0–2]": the base name and, when given, its minimum / maximum. */
export function describeSubtree(subtree: GeneralSubtree, ctx: ExtensionContext): string {
  const { minimum, maximum } = subtree;
  if (minimum === 0 && maximum === undefined) {
    return ctx.name(subtree.base); // the default range [0–∞) says nothing
  }
  const upper = maximum === undefined ? "" : `–${String(maximum)}`;
  return `${ctx.name(subtree.base)} [${String(minimum)}${upper}]`;
}

const names = (list: readonly GeneralName[], ctx: ExtensionContext): Value => ({
  lines: list.map(ctx.name),
});

/** The name, reasons and CRL issuer of a distribution point (or of an IDP's scope). */
function pointRows(point: DistributionPoint, ctx: ExtensionContext): Row[] {
  const { distributionPoint: name, reasons, cRLIssuer } = point;
  const relative = name?.nameRelativeToCRLIssuer?.attributes.map(formatAttribute).join("+");
  return rows(
    name?.fullName !== undefined && {
      label: ctx.field("fullName"),
      value: names(name.fullName, ctx),
    },
    relative !== undefined && {
      label: ctx.field("nameRelativeToCRLIssuer"),
      value: { lines: [relative] },
    },
    reasons !== undefined && { label: ctx.field("reasons"), value: { tags: reasons } },
    cRLIssuer !== undefined && { label: ctx.field("crlIssuer"), value: names(cRLIssuer, ctx) }
  );
}

function qualifierRow(qualifier: PolicyQualifier, ctx: ExtensionContext): Row {
  const { cpsUri, userNotice } = qualifier;
  if (cpsUri !== undefined) {
    return { label: ctx.field("cps"), value: { lines: [cpsUri] } };
  }
  if (userNotice !== undefined) {
    const { organization, noticeNumbers, explicitText } = userNotice;
    const numbers = noticeNumbers?.length ? ` (${noticeNumbers.join(", ")})` : "";
    const lines = [organization === undefined ? "" : `${organization}${numbers}`, explicitText];
    return { label: ctx.field("userNotice"), value: lines.filter(Boolean).join("\n") };
  }
  return {
    label: qualifier.qualifierId.name ?? qualifier.qualifierId.oid,
    value: { hex: qualifier.rawHex },
  };
}

/** One section per policy: its identifier, then its qualifiers. */
const policySections = (policies: readonly PolicyInformation[], ctx: ExtensionContext) =>
  policies.map((policy) => [
    { label: ctx.field("policy"), value: oidText(policy.policyIdentifier) },
    ...(policy.policyQualifiers ?? []).map((qualifier) => qualifierRow(qualifier, ctx)),
  ]);

/**
 * The sections of a decoded extension value, in display order, empty ones dropped (none: the view
 * reads "(empty)"); null for an extensionType this build does not know.
 */
export function describeExtension(
  value: ParsedExtensionValue,
  ctx: ExtensionContext
): Section[] | null {
  return sectionsOf(value, ctx)?.filter((section) => section.length > 0) ?? null;
}

function sectionsOf(value: ParsedExtensionValue, ctx: ExtensionContext): Section[] | null {
  const { field, time, yesNo } = ctx;
  const row = (key: FieldKey, rowValue: Value | null | undefined): Row => ({
    label: field(key),
    value: rowValue,
  });
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
      return [[row("names", names(value.names, ctx))]];
    case "subjectKeyIdentifier":
      return [[row("keyId", { hex: value.keyIdentifier })]];
    case "authorityKeyIdentifier": {
      const { keyIdentifier, authorityCertIssuer, authorityCertSerialNumber } = value;
      return [
        rows(
          keyIdentifier !== undefined && row("keyId", { hex: keyIdentifier }),
          authorityCertIssuer !== undefined &&
            row("authorityCertIssuer", names(authorityCertIssuer, ctx)),
          authorityCertSerialNumber !== undefined &&
            row("authorityCertSerialNumber", { hex: authorityCertSerialNumber })
        ),
      ];
    }
    case "cRLDistributionPoints":
    case "freshestCRL":
    case "msCrlSelfCdp":
      return value.distributionPoints.map((point) => pointRows(point, ctx));
    case "authorityInfoAccess":
    case "subjectInfoAccess":
      return [
        value.accessDescriptions.map((access) => ({
          label: ctx.accessMethod(access.accessMethod),
          value: names([access.accessLocation], ctx),
        })),
      ];
    case "certificatePolicies":
    case "msApplicationPolicies":
      return policySections(value.policies, ctx);
    case "nameConstraints": {
      const subtrees = (list: readonly GeneralSubtree[]): Value => ({
        lines: list.map((subtree) => describeSubtree(subtree, ctx)),
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
      return [[...pointRows(point, ctx), ...flags.map((key) => row(key, yesNo(true)))]];
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
