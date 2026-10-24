// A strict reader of DER values, in the style of Go's cryptobyte (crypto/x509/parser.go): a
// decoder reads the elements of a constructed value in order and names the tag of each one; an
// unexpected or left-over element throws. asn1js only splits the bytes into TLV blocks; no PKIjs
// extension model and no compareSchema (which accepts extra SEQUENCE elements) is involved.
import { fromBER, Integer, ObjectIdentifier } from "asn1js";
import type { BaseBlock } from "asn1js";
import { asciiOf, assertWellFormed, integerNumber } from "./asn1.ts";
import { encodeTlv } from "./pem.ts";

export interface Tag {
  readonly cls: number;
  readonly num: number;
  /** As the ASN.1 dump writes it (SEQUENCE, [0]), for error messages. */
  readonly name: string;
}

const universal = (num: number, name: string): Tag => ({ cls: 1, num, name });
export const context = (num: number): Tag => ({ cls: 3, num, name: `[${String(num)}]` });
export const BOOLEAN = universal(1, "BOOLEAN");
export const INTEGER = universal(2, "INTEGER");
export const BIT_STRING = universal(3, "BIT STRING");
export const OCTET_STRING = universal(4, "OCTET STRING");
export const NULL = universal(5, "NULL");
export const OBJECT_IDENTIFIER = universal(6, "OBJECT IDENTIFIER");
export const ENUMERATED = universal(10, "ENUMERATED");
export const SEQUENCE = universal(16, "SEQUENCE");
export const SET = universal(17, "SET");
export const IA5_STRING = universal(22, "IA5String");
export const GENERALIZED_TIME = universal(24, "GeneralizedTime");

export function hasTag(block: BaseBlock, tag: Tag): boolean {
  return block.idBlock.tagClass === tag.cls && block.idBlock.tagNumber === tag.num;
}

/**
 * Exactly one element filling `bytes`, as asn1js decodes it: BER is let through (an extnValue
 * holds the encoding of one value; trailing bytes are an error).
 */
export function readOne(bytes: Uint8Array): BaseBlock {
  const parsed = fromBER(bytes);
  if (parsed.offset !== bytes.byteLength || parsed.result.error !== "") {
    throw new Error("Invalid ASN.1 value");
  }
  return parsed.result;
}

/** readOne, and DER throughout (assertWellFormed). */
export function readDer(bytes: Uint8Array): BaseBlock {
  const block = readOne(bytes);
  assertWellFormed(block);
  return block;
}

/** `block` itself when it has this tag. */
export function expectTag(block: BaseBlock, tag: Tag): BaseBlock {
  if (!hasTag(block, tag)) {
    throw new Error(`Expected ${tag.name}`);
  }
  return block;
}

/** An implicitly tagged primitive as the universal type `tag` ([0] IMPLICIT GeneralizedTime). */
export function asUniversal(block: BaseBlock, tag: Tag): BaseBlock {
  return readDer(encodeTlv(tag.num, [contents(block)]));
}

/** The contents octets of a primitive element, also when it is implicitly tagged. */
export function contents(block: BaseBlock): Uint8Array {
  if (block.idBlock.isConstructed) {
    throw new Error("Expected a primitive ASN.1 element");
  }
  return block.valueBeforeDecodeView.subarray(
    block.idBlock.blockLength + block.lenBlock.blockLength
  );
}

/** The elements of one constructed value, read in order. */
export class DerReader {
  readonly #items: readonly BaseBlock[];
  #next = 0;

  constructor(block: BaseBlock, tag: Tag = SEQUENCE) {
    const value: unknown = (block.valueBlock as { value?: unknown }).value;
    if (!block.idBlock.isConstructed || !hasTag(block, tag) || !Array.isArray(value)) {
      throw new Error(`Expected a constructed ${tag.name}`);
    }
    this.#items = value as BaseBlock[];
  }

  /**
   * The next element when it has this tag (an OPTIONAL or DEFAULT field), else undefined; without
   * a tag, the next element whatever its tag (an OPTIONAL CHOICE or ANY that ends the value).
   */
  optional(tag?: Tag): BaseBlock | undefined {
    const item = this.#items[this.#next];
    if (item === undefined || (tag !== undefined && !hasTag(item, tag))) {
      return undefined;
    }
    this.#next++;
    return item;
  }

  /** The next element, which must have this tag. */
  read(tag: Tag): BaseBlock {
    const item = this.optional(tag);
    if (item === undefined) {
      throw new Error(`Missing ${tag.name}`);
    }
    return item;
  }

  /** The next element, whatever its tag (a CHOICE or an ANY). */
  any(): BaseBlock {
    const item = this.optional();
    if (item === undefined) {
      throw new Error("Missing ASN.1 element");
    }
    return item;
  }

  /** The remaining elements of a SEQUENCE OF / SET OF, at least `min` of them. */
  rest(min = 1): BaseBlock[] {
    const items = this.#items.slice(this.#next);
    if (items.length < min) {
      throw new Error("Too few elements");
    }
    this.#next = this.#items.length;
    return items;
  }

  /** Throws when an element is left over. */
  end(): void {
    if (this.#next !== this.#items.length) {
      throw new Error("Unexpected ASN.1 element");
    }
  }
}

/** The elements of a SEQUENCE OF (or an implicitly tagged one), at least `min` of them. */
export function sequenceOf(block: BaseBlock, tag: Tag = SEQUENCE, min = 1): BaseBlock[] {
  return new DerReader(block, tag).rest(min);
}

/** The one element under an EXPLICIT tag (a CHOICE or an ANY under [n]). */
export function explicit(block: BaseBlock, tag: Tag): BaseBlock {
  const wrapper = new DerReader(block, tag);
  const item = wrapper.any();
  wrapper.end();
  return item;
}

/** BOOLEAN contents: 00 or FF only (X.690 §11.1). */
export function readBoolean(block: BaseBlock): boolean {
  const [byte, ...rest] = contents(block);
  if ((byte !== 0 && byte !== 0xff) || rest.length > 0) {
    throw new Error("Invalid BOOLEAN");
  }
  return byte === 0xff;
}

/** INTEGER contents (also implicitly tagged) as an asn1js Integer, at least one octet. */
function integerOf(block: BaseBlock): Integer {
  const bytes = contents(block);
  if (bytes.length === 0) {
    throw new Error("Invalid INTEGER");
  }
  return new Integer({ valueHex: bytes });
}

/** INTEGER contents as a number; beyond a safe integer it is an error. */
export const readInteger = (block: BaseBlock): number => integerNumber(integerOf(block));

/** INTEGER contents as a bigint, of any length (CRL numbers, notice numbers). */
export const readBigInt = (block: BaseBlock): bigint => integerOf(block).toBigInt();

/** BIT STRING contents as the names of its set bits; the first octet counts the unused bits. */
export function readBits(block: BaseBlock, names: readonly string[]): string[] {
  const [unused = 8, ...bytes] = contents(block);
  // X.690 §11.2.1: the unused bits of the last octet are zero.
  const padding = (bytes.at(-1) ?? 0) & ((1 << unused) - 1);
  if (unused > 7 || (bytes.length === 0 && unused !== 0) || padding !== 0) {
    throw new Error("Invalid BIT STRING");
  }
  const totalBits = bytes.length * 8 - unused;
  return names.filter(
    (_name, index) => index < totalBits && ((bytes[index >> 3] ?? 0) & (0x80 >> (index & 7))) !== 0
  );
}

/** OBJECT IDENTIFIER contents (also implicitly tagged, as registeredID) as dotted text. */
export function readOid(block: BaseBlock): string {
  const bytes = contents(block);
  const oid = new ObjectIdentifier();
  if (bytes.length === 0 || oid.valueBlock.fromBER(bytes, 0, bytes.length) !== bytes.length) {
    throw new Error("Invalid OBJECT IDENTIFIER");
  }
  return oid.valueBlock.toString();
}

/** Contents octets as text, one character per octet (IA5String, also implicitly tagged). */
export const readAscii = (block: BaseBlock): string => asciiOf(contents(block));
