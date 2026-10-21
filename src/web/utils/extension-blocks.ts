// What the UI shows for each decoded extension value: a list of render blocks (plan §8: rows, tags,
// general names, distribution points, access descriptions, policies, subtrees), drawn by
// components/x509/ExtensionView.vue. From worker-aia-cdp@5b570aa:src/web/components/ExtensionView.vue
// (Block, describe(), describeSubtree and helpers), with the texts that depend on the UI language
// injected through ExtensionContext so the mapping is testable without a component.
//
// The 41 extensionType values and their fields are the contract with src/core/summary/schemas.ts:
// the switch is exhaustive, so a value added there fails to compile here until it has a case. A
// type this build does not know (a newer server) yields null, and the view falls back to the
// raw value; there is no generic JSON block.
import type {
  AccessDescription,
  DistributionPoint,
  GeneralName,
  GeneralSubtree,
  ObjectIdentifier,
  ParsedExtensionValue,
  PolicyInformation,
} from "@/client/types";
import { formatGeneralName } from "@/utils/x509";

/** One label / value line; `hex` values are shown grouped with a copy button. */
export interface Row {
  label: string;
  value: string;
  hex?: boolean;
}

/** Tag colours by meaning of the list: flags (blue), purposes / scopes (purple), reasons (amber). */
export type TagTone = "blue" | "purple" | "amber";

export type Block =
  | { kind: "rows"; rows: Row[] }
  | { kind: "tags"; tags: string[]; tone: TagTone }
  | { kind: "names"; title?: string; names: GeneralName[] }
  | { kind: "points"; points: DistributionPoint[] }
  | { kind: "access"; items: AccessDescription[] }
  | { kind: "policies"; policies: PolicyInformation[] }
  | { kind: "subtrees"; title: string; subtrees: GeneralSubtree[] };

/** The UI-language texts a block needs (ExtensionView binds them to vue-i18n). */
export interface ExtensionContext {
  /** Label of a field: `extension.fields.<key>`. */
  field: (key: string) => string;
  /** Short label of a general name type: `extension.generalName.<type>`. */
  nameLabel: (type: GeneralName["type"]) => string;
  /** An ISO date-time for display; N/A when absent. */
  time: (iso: string | undefined) => string;
  yesNo: (value: boolean) => string;
}

/** "name (oid)", or the OID alone when it has no known name. */
export function oidText(oid: ObjectIdentifier): string {
  return oid.name ? `${oid.name} (${oid.oid})` : oid.oid;
}

/** "DNS: example.com [0–2]": the base name and, when given, its minimum / maximum. */
export function describeSubtree(
  subtree: GeneralSubtree,
  ctx: Pick<ExtensionContext, "nameLabel">
): string {
  const base = formatGeneralName(subtree.base, ctx.nameLabel);
  const { minimum, maximum } = subtree;
  if (minimum === undefined && maximum === undefined) {
    return base;
  }
  const upper = maximum === undefined ? "" : `–${String(maximum)}`;
  return `${base} [${String(minimum ?? 0)}${upper}]`;
}

const rows = (...list: Row[]): Block => ({ kind: "rows", rows: list });

/**
 * The render blocks of a decoded extension value, in display order; null for an extensionType this
 * build does not know.
 */
export function describeExtension(
  value: ParsedExtensionValue,
  ctx: ExtensionContext
): Block[] | null {
  const { field, time, yesNo } = ctx;
  switch (value.extensionType) {
    case "basicConstraints":
      return [
        rows(
          { label: field("ca"), value: yesNo(value.cA) },
          ...(value.pathLenConstraint !== undefined
            ? [{ label: field("pathLength"), value: String(value.pathLenConstraint) }]
            : [])
        ),
      ];
    case "keyUsage":
      return [{ kind: "tags", tags: value.usages, tone: "blue" }];
    case "extendedKeyUsage":
      return [{ kind: "tags", tags: value.purposes.map((p) => p.name ?? p.oid), tone: "purple" }];
    case "tlsFeature":
      return [
        { kind: "tags", tags: value.features.map((f) => f.name ?? String(f.code)), tone: "blue" },
      ];
    case "netscapeCertType":
      return [{ kind: "tags", tags: value.flags, tone: "blue" }];
    case "subjectAltName":
    case "issuerAltName":
    case "certificateIssuer":
      return [{ kind: "names", names: value.names }];
    case "subjectKeyIdentifier":
      return [rows({ label: field("keyId"), value: value.keyIdentifier, hex: true })];
    case "authorityKeyIdentifier": {
      const blocks: Block[] = [];
      const list: Row[] = [];
      if (value.keyIdentifier) {
        list.push({ label: field("keyId"), value: value.keyIdentifier, hex: true });
      }
      if (value.authorityCertSerialNumber) {
        list.push({
          label: field("authorityCertSerialNumber"),
          value: value.authorityCertSerialNumber,
          hex: true,
        });
      }
      if (list.length > 0) {
        blocks.push({ kind: "rows", rows: list });
      }
      if (value.authorityCertIssuer?.length) {
        blocks.push({
          kind: "names",
          title: field("authorityCertIssuer"),
          names: value.authorityCertIssuer,
        });
      }
      return blocks;
    }
    case "cRLDistributionPoints":
    case "freshestCRL":
    case "msCrlSelfCdp":
      return [{ kind: "points", points: value.distributionPoints }];
    case "authorityInfoAccess":
    case "subjectInfoAccess":
      return [{ kind: "access", items: value.accessDescriptions }];
    case "certificatePolicies":
    case "msApplicationPolicies":
      return [{ kind: "policies", policies: value.policies }];
    case "nameConstraints": {
      const blocks: Block[] = [];
      if (value.permittedSubtrees?.length) {
        blocks.push({
          kind: "subtrees",
          title: field("permittedSubtrees"),
          subtrees: value.permittedSubtrees,
        });
      }
      if (value.excludedSubtrees?.length) {
        blocks.push({
          kind: "subtrees",
          title: field("excludedSubtrees"),
          subtrees: value.excludedSubtrees,
        });
      }
      return blocks;
    }
    case "issuingDistributionPoint": {
      const blocks: Block[] = [];
      if (value.distributionPoint) {
        blocks.push({ kind: "points", points: [{ distributionPoint: value.distributionPoint }] });
      }
      const flags = (
        [
          ["onlyContainsUserCerts", value.onlyContainsUserCerts],
          ["onlyContainsCACerts", value.onlyContainsCACerts],
          ["onlyContainsAttributeCerts", value.onlyContainsAttributeCerts],
          ["indirectCRL", value.indirectCRL],
        ] as const
      )
        .filter(([, set]) => set === true)
        .map(([key]) => field(key));
      if (flags.length > 0) {
        blocks.push({ kind: "tags", tags: flags, tone: "purple" });
      }
      if (value.onlySomeReasons?.length) {
        blocks.push({ kind: "tags", tags: value.onlySomeReasons, tone: "amber" });
      }
      return blocks;
    }
    case "cRLNumber":
      return [rows({ label: field("crlNumber"), value: value.number })];
    case "deltaCRLIndicator":
      return [rows({ label: field("baseCrlNumber"), value: value.baseCRLNumber })];
    case "msCrlVirtualBase":
      return [rows({ label: field("crlNumber"), value: value.number })];
    case "cRLReason":
      return [rows({ label: field("reason"), value: `${value.name} (${String(value.code)})` })];
    case "holdInstructionCode":
      return [rows({ label: field("holdInstruction"), value: oidText(value.instruction) })];
    case "invalidityDate":
      return [rows({ label: field("invalidityDate"), value: time(value.date.iso) })];
    case "expiredCertsOnCRL":
      return [rows({ label: field("expiredCertsOnCRL"), value: time(value.date.iso) })];
    case "msCrlNextPublish":
      return [rows({ label: field("nextCrlPublish"), value: time(value.date.iso) })];
    case "privateKeyUsagePeriod":
      return [
        rows(
          { label: field("notBefore"), value: time(value.notBefore?.iso) },
          { label: field("notAfter"), value: time(value.notAfter?.iso) }
        ),
      ];
    case "policyConstraints":
      return [
        rows(
          ...(value.requireExplicitPolicy !== undefined
            ? [
                {
                  label: field("requireExplicitPolicy"),
                  value: String(value.requireExplicitPolicy),
                },
              ]
            : []),
          ...(value.inhibitPolicyMapping !== undefined
            ? [{ label: field("inhibitPolicyMapping"), value: String(value.inhibitPolicyMapping) }]
            : [])
        ),
      ];
    case "policyMappings":
      return [
        rows(
          ...value.mappings.map((m) => ({
            label: oidText(m.issuerDomainPolicy),
            value: oidText(m.subjectDomainPolicy),
          }))
        ),
      ];
    case "inhibitAnyPolicy":
      return [rows({ label: field("skipCerts"), value: String(value.skipCerts) })];
    case "signedCertificateTimestampList":
      return [
        rows(
          ...value.timestamps.flatMap((sct) => [
            { label: field("logId"), value: sct.logId, hex: true },
            { label: field("timestamp"), value: time(sct.timestamp) },
            {
              label: field("signatureAlgorithm"),
              value: `${sct.hashAlgorithm}/${sct.signatureAlgorithm}`,
            },
          ])
        ),
      ];
    case "ocspNoCheck":
      return [rows({ label: field("ocspNoCheck"), value: yesNo(true) })];
    case "netscapeComment":
      return [rows({ label: field("comment"), value: value.comment })];
    case "qcStatements":
      // A statement without statementInfo has an empty value; the view shows "(empty)".
      return [
        rows(
          ...value.statements.map((s) => ({
            label: oidText(s.statementId),
            value: s.rawHex,
            hex: s.rawHex.length > 0,
          }))
        ),
      ];
    case "subjectDirectoryAttributes":
      return [
        rows(
          ...value.attributes.map((a) => ({ label: oidText(a.type), value: a.values.join("; ") }))
        ),
      ];
    case "msCaVersion":
      return [
        rows(
          { label: field("certificateIndex"), value: String(value.certificateIndex) },
          { label: field("keyIndex"), value: String(value.keyIndex) }
        ),
      ];
    case "msCertificateTemplateName":
      return [rows({ label: field("templateName"), value: value.name })];
    case "msCertificateTemplate":
      return [
        rows(
          { label: field("templateId"), value: oidText(value.templateId) },
          {
            label: field("templateVersion"),
            value: `${String(value.majorVersion ?? 0)}.${String(value.minorVersion ?? 0)}`,
          }
        ),
      ];
    case "msPreviousCaCertificateHash":
      return [rows({ label: field("previousCaCertificateHash"), value: value.hash, hex: true })];
    case "msNtdsCaSecurity":
      return [rows({ label: field("sid"), value: value.sid })];
    default: {
      // Compile-time exhaustiveness; at run time, a type of a newer server.
      const _exhaustive: never = value;
      void _exhaustive;
      return null;
    }
  }
}
