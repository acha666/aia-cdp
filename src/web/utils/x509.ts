// One-line texts for X.509 name attributes, algorithms and general names; the "salt" of RSASSA-PSS
// parameters and the general-name type labels come from i18n.
import type {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  GeneralName,
  ObjectIdentifier,
} from "@/client/types";
import type { I18nText } from "@/i18n";

/**
 * "commonName=x" with the attribute type's name (or OID), unescaped; a value that is no string is
 * "#hex". Not core's RFC 4514 text: the API names an attribute type only by its long name.
 */
export function formatAttribute(attribute: AttributeTypeAndValue): string {
  const key = attribute.type.name ?? attribute.type.oid;
  const value = attribute.value.string ?? `#${attribute.value.rawHex ?? ""}`;
  return `${key}=${value}`;
}

function oidLabel(oid: ObjectIdentifier): string {
  return oid.name ?? oid.oid;
}

/** Algorithm name followed by decoded parameters, e.g. "RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)". */
export function formatAlgorithm(algorithm: AlgorithmIdentifier, i18n: Pick<I18nText, "t">): string {
  const base = oidLabel(algorithm.algorithm);
  const parsed = algorithm.parameters?.parsed;
  if (parsed === undefined) {
    return base;
  }
  switch (parsed.type) {
    case "null":
      return base;
    case "objectIdentifier":
      return `${base} (${oidLabel(parsed.oid)})`;
    case "rsassaPss": {
      const mask = parsed.maskGenHashAlgorithm
        ? `${oidLabel(parsed.maskGenAlgorithm)}/${oidLabel(parsed.maskGenHashAlgorithm)}`
        : oidLabel(parsed.maskGenAlgorithm);
      const salt = i18n.t("algorithm.salt", { length: parsed.saltLength });
      return `${base} (${oidLabel(parsed.hashAlgorithm)}, ${mask}, ${salt})`;
    }
  }
}

/**
 * "DNS: host" style text, after the UI's short label of the type (extension.generalName.*);
 * otherName types show their known name or type OID.
 */
export function formatGeneralName(name: GeneralName, i18n: Pick<I18nText, "t">): string {
  const label = i18n.t(`extension.generalName.${name.type}`);
  const prefix = name.type === "otherName" ? (name.typeName ?? name.typeOid ?? label) : label;
  const value = name.value || (name.rawHex ?? "");
  return `${prefix}: ${value}`;
}
