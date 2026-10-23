// One-line texts for X.509 names, algorithms and general names. formatAttribute is exported for
// DistributionPointList; the "salt" of RSASSA-PSS parameters comes from i18n.
import type {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  GeneralName,
  Name,
  ObjectIdentifier,
} from "@/client/types";

/** "CN=x" with the attribute's short name (or OID); a value that is no string is left empty. */
export function formatAttribute(attribute: AttributeTypeAndValue): string {
  const key = attribute.type.name ?? attribute.type.oid;
  const value = attribute.value.string ?? "";
  return `${key}=${value}`;
}

/** The RFC 4514 form from the API; built from the RDNs only if that is empty. */
export function formatName(name: Name): string {
  if (name.rfc4514 !== "") {
    return name.rfc4514;
  }
  return name.rdnSequence
    .map((rdn) => rdn.attributes.map(formatAttribute).join("+"))
    .filter((entry) => entry.length > 0)
    .join(", ");
}

function oidLabel(oid: ObjectIdentifier): string {
  return oid.name ?? oid.oid;
}

/** The salt length of RSASSA-PSS parameters, as the UI language writes it ("salt 32"). */
export type SaltLabel = (length: number) => string;

/** Algorithm name followed by decoded parameters, e.g. "RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)". */
export function formatAlgorithm(
  algorithm: AlgorithmIdentifier | null | undefined,
  salt: SaltLabel
): string | null {
  if (algorithm === null || algorithm === undefined) {
    return null;
  }
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
      return `${base} (${oidLabel(parsed.hashAlgorithm)}, ${mask}, ${salt(parsed.saltLength)})`;
    }
  }
}

/** The UI's short label of a general name type ("DNS", "URI", ...). */
export type GeneralNameLabel = (type: GeneralName["type"]) => string;

/** "DNS: host" style text; otherName types show their known name or type OID. */
export function formatGeneralName(name: GeneralName, label: GeneralNameLabel): string {
  const prefix =
    name.type === "otherName"
      ? (name.typeName ?? name.typeOid ?? label(name.type))
      : label(name.type);
  const value = name.value || (name.rawHex ?? "");
  return `${prefix}: ${value}`;
}
