// Detail builders for the X.509 building blocks: version, serial, bit strings, algorithm
// identifiers, times, names, public keys and fingerprints. buildTime takes the pkijs.Time it
// formats (reading .value and .type), formatGeneralizedTime is the one in ../pki/asn1.ts, and the
// RSASSA-PSS integers are read from their contents octets (PKIjs's numbers are asn1js's valueDec).
import {
  BaseBlock,
  Constructed,
  fromBER,
  Integer,
  Null,
  ObjectIdentifier,
  Sequence,
  Set as Asn1Set,
} from "asn1js";
import type { BitString as Asn1BitString } from "asn1js";
import * as pkijs from "pkijs";
import { blockHex, formatGeneralizedTime, integerNumber, stringOf } from "../pki/asn1.ts";
import {
  OID_DICTIONARY,
  KEY_ALG_NAMES,
  CURVE_NAMES,
  HASH_ALG_NAMES,
  MASK_GEN_ALG_NAMES,
} from "../pki/constants.ts";
import { sha1Hex, sha256Hex, toHex, toUpperHex } from "../digest.ts";
import type {
  X509Version,
  SerialNumber,
  BitString,
  SignatureValue,
  ObjectIdentifier as ObjectIdentifierValue,
  AlgorithmIdentifier,
  AlgorithmParameters,
  AlgorithmParametersParsed,
  Time,
  Name,
  RelativeDistinguishedName,
  AttributeTypeAndValue,
  AttributeValue,
  SubjectPublicKeyInfo,
  RSAPublicKey,
  ECPublicKey,
  Fingerprints,
} from "./schemas.ts";

/**
 * `value instanceof BaseBlock` narrows `unknown` to BaseBlock<any, any>, which typescript-eslint
 * rejects as an argument (no-unsafe-argument); this guard narrows to BaseBlock.
 */
function isBlock(value: unknown): value is BaseBlock {
  return value instanceof BaseBlock;
}

export function buildVersion(version: number | undefined): X509Version {
  const raw = version ?? 0;
  const display = raw === 0 ? "v1" : raw === 1 ? "v2" : "v3";
  return { raw, display };
}

export function buildSerialNumber(integer: Integer): SerialNumber {
  const hex = toUpperHex(integer.valueBlock.valueHexView);
  return { hex, decimal: BigInt(`0x${hex}`).toString() };
}

function buildBitString(bitString: Asn1BitString): BitString {
  const { valueHexView: bytes, unusedBits } = bitString.valueBlock;
  return { hex: toUpperHex(bytes), bitLength: bytes.length * 8 - unusedBits, unusedBits };
}

/** Raw content of an implicitly tagged BIT STRING (first octet is the unused-bit count). */
export function buildBitStringFromContent(content: ArrayBuffer): BitString | undefined {
  const bytes = new Uint8Array(content);
  const [first] = bytes;
  if (first === undefined) {
    return undefined;
  }
  const unusedBits = first <= 7 ? first : 0;
  const body = bytes.subarray(1);
  return {
    hex: toUpperHex(body),
    bitLength: body.length * 8 - unusedBits,
    unusedBits,
  };
}

const SIGNATURE_FAMILIES: Record<string, "ecdsa" | "dsa"> = {
  "1.2.840.10045.4.1": "ecdsa",
  "1.2.840.10045.4.3.1": "ecdsa",
  "1.2.840.10045.4.3.2": "ecdsa",
  "1.2.840.10045.4.3.3": "ecdsa",
  "1.2.840.10045.4.3.4": "ecdsa",
  "1.2.840.10040.4.3": "dsa",
  "2.16.840.1.101.3.4.3.1": "dsa",
  "2.16.840.1.101.3.4.3.2": "dsa",
};

function unsignedHex(integer: Integer): string {
  const bytes = integer.valueBlock.valueHexView;
  const trimmed =
    bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) !== 0
      ? bytes.subarray(1)
      : bytes;
  return toUpperHex(trimmed);
}

/** Signature bits plus the (r, s) pair for DSA-style signatures when the DER sequence decodes. */
export function buildSignatureValue(bitString: Asn1BitString, algorithmId: string): SignatureValue {
  const base = buildBitString(bitString);
  const family = SIGNATURE_FAMILIES[algorithmId];
  if (!family) {
    return base;
  }
  const decoded = fromBER(bitString.valueBlock.valueHexView);
  if (decoded.offset === -1 || !(decoded.result instanceof Sequence)) {
    return base;
  }
  const [r, s] = decoded.result.valueBlock.value;
  if (!(r instanceof Integer) || !(s instanceof Integer)) {
    return base;
  }
  return { ...base, parsed: { type: family, r: unsignedHex(r), s: unsignedHex(s) } };
}

export function buildObjectIdentifier(
  oid: string,
  dictionary?: Record<string, string>
): ObjectIdentifierValue {
  const dictEntry = OID_DICTIONARY[oid];
  const algName = dictionary?.[oid];
  return {
    oid,
    name: algName ?? dictEntry?.name ?? null,
  };
}

const RSASSA_PSS_OID = "1.2.840.113549.1.1.10";

/**
 * The INTEGER of the [tagNumber] EXPLICIT field of `params`, as a number; undefined when the field
 * is absent (RFC 4055 §3.1: saltLength [2], trailerField [3]). PKIjs's own numbers are valueDec,
 * 0 from four contents octets on.
 */
function explicitInteger(params: Sequence, tagNumber: number): number | undefined {
  const field = params.valueBlock.value.find(
    (block) => block.idBlock.tagClass === 3 && block.idBlock.tagNumber === tagNumber
  );
  const [value] = field instanceof Constructed ? field.valueBlock.value : [];
  return value instanceof Integer ? integerNumber(value) : undefined;
}

function parseRsassaPssParams(params: Sequence): AlgorithmParametersParsed | undefined {
  try {
    const pss = new pkijs.RSASSAPSSParams({ schema: params });
    const mgfParams: unknown = pss.maskGenAlgorithm.algorithmParams;
    let maskGenHashAlgorithm: ObjectIdentifierValue | undefined;
    if (mgfParams instanceof Sequence) {
      try {
        const hash = new pkijs.AlgorithmIdentifier({ schema: mgfParams });
        maskGenHashAlgorithm = buildObjectIdentifier(hash.algorithmId, HASH_ALG_NAMES);
      } catch {
        // An MGF1 hash that does not decode is left out.
      }
    }
    return {
      type: "rsassaPss",
      hashAlgorithm: buildObjectIdentifier(pss.hashAlgorithm.algorithmId, HASH_ALG_NAMES),
      maskGenAlgorithm: buildObjectIdentifier(pss.maskGenAlgorithm.algorithmId, MASK_GEN_ALG_NAMES),
      maskGenHashAlgorithm,
      // PKIjs's defaults (20 and 1, RFC 4055 §3.1) when absent.
      saltLength: explicitInteger(params, 2) ?? pss.saltLength,
      trailerField: explicitInteger(params, 3) ?? pss.trailerField,
    };
  } catch {
    return undefined;
  }
}

function buildAlgorithmParameters(algorithmId: string, params: BaseBlock): AlgorithmParameters {
  const rawHex = blockHex(params);
  let parsed: AlgorithmParametersParsed | undefined;
  if (params instanceof Null) {
    parsed = { type: "null" };
  } else if (params instanceof ObjectIdentifier) {
    parsed = {
      type: "objectIdentifier",
      oid: buildObjectIdentifier(params.valueBlock.toString(), CURVE_NAMES),
    };
  } else if (algorithmId === RSASSA_PSS_OID && params instanceof Sequence) {
    parsed = parseRsassaPssParams(params);
  }
  return parsed ? { rawHex, parsed } : { rawHex };
}

export function buildAlgorithmIdentifier(
  algorithm: pkijs.AlgorithmIdentifier,
  dictionary?: Record<string, string>
): AlgorithmIdentifier {
  const params: unknown = algorithm.algorithmParams;
  const result: AlgorithmIdentifier = {
    algorithm: buildObjectIdentifier(algorithm.algorithmId, dictionary),
  };
  if (isBlock(params)) {
    result.parameters = buildAlgorithmParameters(algorithm.algorithmId, params);
  }
  return result;
}

/** Throws a RangeError for an invalid date (toISOString). */
export function buildTime(time: pkijs.Time): Time {
  const iso = time.value.toISOString();
  const type = time.type === pkijs.TimeType.GeneralizedTime ? "generalizedTime" : "utcTime";
  const generalized = formatGeneralizedTime(time.value);
  return { iso, type, raw: type === "utcTime" ? generalized.slice(2) : generalized };
}

// =============================================================================
// Name Builder
// =============================================================================

const ENCODING_BY_TAG: Record<number, AttributeValue["encoding"]> = {
  12: "utf8String",
  18: "numericString",
  19: "printableString",
  20: "teletexString",
  22: "ia5String",
  26: "visibleString",
  27: "generalString",
  28: "universalString",
  30: "bmpString",
};

/** RFC 4514 §2.4 escaping for a single attribute value. */
export function escapeRdnValue(value: string): string {
  let escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/[,+"<>;]/g, (char) => `\\${char}`)
    .replace(/\0/g, "\\00");
  if (escaped.startsWith("#") || escaped.startsWith(" ")) {
    escaped = `\\${escaped}`;
  }
  if (escaped.endsWith(" ") && !escaped.endsWith("\\ ")) {
    escaped = `${escaped.slice(0, -1)}\\ `;
  }
  return escaped;
}

function attributeLabel(oid: string): string {
  const entry = OID_DICTIONARY[oid];
  return entry?.short ?? entry?.name ?? oid;
}

function formatRfc4514(rdnSequence: RelativeDistinguishedName[]): string {
  return [...rdnSequence]
    .reverse()
    .map((rdn) =>
      rdn.attributes
        .map((attribute) => {
          const label = attributeLabel(attribute.type.oid);
          const value =
            attribute.value.string !== null
              ? escapeRdnValue(attribute.value.string)
              : `#${(attribute.value.rawHex ?? "").toLowerCase()}`;
          return `${label}=${value}`;
        })
        .join("+")
    )
    .join(",");
}

export function buildName(name: pkijs.RelativeDistinguishedNames): Name {
  const rdnSequence = name.toSchema().valueBlock.value.map((group): RelativeDistinguishedName => {
    if (!(group instanceof Asn1Set)) {
      throw new Error("Invalid RDN set");
    }
    return {
      attributes: group.valueBlock.value.map((schema): AttributeTypeAndValue => {
        const tv = new pkijs.AttributeTypeAndValue({ schema });
        const block: unknown = tv.value;
        const tagNumber =
          block instanceof BaseBlock && block.idBlock.tagClass === 1 ? block.idBlock.tagNumber : -1;
        const value: AttributeValue = {
          string: stringOf(block) ?? null,
          encoding: ENCODING_BY_TAG[tagNumber] ?? "unknown",
        };
        if (value.string === null && isBlock(block)) {
          value.rawHex = blockHex(block);
        }
        return { type: buildObjectIdentifier(tv.type), value };
      }),
    };
  });

  // The normalized fields: the first string value of each attribute type, in RDN order.
  const attributes = rdnSequence.flatMap((rdn) => rdn.attributes);
  const first = (oid: string) =>
    attributes.find((a) => a.type.oid === oid && a.value.string !== null)?.value.string ?? null;
  return {
    commonName: first("2.5.4.3"),
    organization: first("2.5.4.10"),
    organizationalUnit: first("2.5.4.11"),
    country: first("2.5.4.6"),
    stateOrProvince: first("2.5.4.8"),
    locality: first("2.5.4.7"),
    rdnSequence,
    rfc4514: formatRfc4514(rdnSequence),
  };
}

// =============================================================================
// Public Key Builder
// =============================================================================

export async function buildSubjectPublicKeyInfo(
  spki: pkijs.PublicKeyInfo
): Promise<SubjectPublicKeyInfo> {
  const algorithm = buildAlgorithmIdentifier(spki.algorithm, KEY_ALG_NAMES);

  const subjectPublicKey = buildBitString(spki.subjectPublicKey);

  // Calculate fingerprints
  const spkiDer = new Uint8Array(spki.toSchema().toBER(false));
  const fingerprints = await buildFingerprints(spkiDer);

  // Parse key based on algorithm
  let parsed: SubjectPublicKeyInfo["parsed"] | undefined;

  const algOid = spki.algorithm.algorithmId;

  if (algOid === "1.2.840.113549.1.1.1" || algOid === RSASSA_PSS_OID) {
    parsed = parseRSAPublicKey(spki);
  } else if (algOid === "1.2.840.10045.2.1") {
    parsed = parseECPublicKey(spki);
  } else if (algOid === "1.3.101.112" || algOid === "1.3.101.113") {
    const keyHex = toUpperHex(spki.subjectPublicKey.valueBlock.valueHex);
    parsed = {
      type: algOid === "1.3.101.112" ? "ed25519" : "ed448",
      publicKey: { hex: keyHex },
    };
  }

  return {
    algorithm,
    subjectPublicKey,
    parsed: parsed ?? { type: "unknown" },
    fingerprints,
  };
}

function parseRSAPublicKey(spki: pkijs.PublicKeyInfo): RSAPublicKey | undefined {
  const key = spki.parsedKey;
  if (!(key instanceof pkijs.RSAPublicKey)) {
    return undefined;
  }
  const modulus = BigInt(`0x${toHex(key.modulus.valueBlock.valueHexView) || "0"}`);
  const exponent = BigInt(`0x${toHex(key.publicExponent.valueBlock.valueHexView) || "0"}`);
  if (modulus <= 0n || exponent <= 0n || exponent > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return {
    type: "rsa",
    modulus: {
      hex: unsignedHex(key.modulus),
      bitLength: modulus.toString(2).length,
    },
    publicExponent: Number(exponent),
  };
}

function parseECPublicKey(spki: pkijs.PublicKeyInfo): ECPublicKey | undefined {
  const key = spki.parsedKey;
  if (!(key instanceof pkijs.ECPublicKey)) {
    return undefined;
  }
  const curve = pkijs.ECNamedCurves.find(key.namedCurve);
  return {
    type: "ec",
    curve: buildObjectIdentifier(curve?.id ?? key.namedCurve, CURVE_NAMES),
    point: {
      hex: toUpperHex(spki.subjectPublicKey.valueBlock.valueHexView),
      x: toUpperHex(key.x),
      y: toUpperHex(key.y),
    },
    // P-521 coordinates occupy 66 bytes but the curve has 521 bits.
    keySize: curve?.id === "1.3.132.0.35" ? 521 : key.x.byteLength * 8,
  };
}

export async function buildFingerprints(der: Uint8Array): Promise<Fingerprints> {
  const [sha1, sha256] = await Promise.all([sha1Hex(der), sha256Hex(der)]);
  return { sha1, sha256 };
}
