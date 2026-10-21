// X.509 text helpers (implementation slice 5b step 2). Shapes are the API's (@/client/types); OID
// names are those of src/core/pki/constants.ts, and the PSS case is the one of the fixture
// crls/issuing-ca-1/full-pss ("RSASSA-PSS SHA-256, MGF1 SHA-256, salt 32").
import { describe, expect, it } from "vitest";
import type { AlgorithmIdentifier, GeneralName, Name } from "@/client/types";
import en from "@/locales/en.json";
import { formatAlgorithm, formatAttribute, formatGeneralName, formatName } from "@/utils/x509";

const salt = (length: number) => `salt ${String(length)}`;
const label = (type: GeneralName["type"]) => en.extension.generalName[type];

describe("formatAlgorithm", () => {
  it("shows RSASSA-PSS parameters with the hash, mask generation and salt length", () => {
    const pss = {
      algorithm: { oid: "1.2.840.113549.1.1.10", name: "RSASSA-PSS" },
      parameters: {
        rawHex:
          "3034a00f300d06096086480165030402010500a11c301a06092a864886f70d010108300d06096086480165030402010500a203020120",
        parsed: {
          type: "rsassaPss",
          hashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
          maskGenAlgorithm: { oid: "1.2.840.113549.1.1.8", name: "MGF1" },
          maskGenHashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
          saltLength: 32,
          trailerField: 1,
        },
      },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(pss, salt)).toBe("RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)");
    expect(formatAlgorithm(pss, (length) => `盐值长度 ${String(length)}`)).toBe(
      "RSASSA-PSS (SHA-256, MGF1/SHA-256, 盐值长度 32)"
    );
    // MGF1 without a decodable hash parameter.
    const { maskGenHashAlgorithm: _, ...withoutMaskHash } = pss.parameters.parsed;
    expect(
      formatAlgorithm({ ...pss, parameters: { ...pss.parameters, parsed: withoutMaskHash } }, salt)
    ).toBe("RSASSA-PSS (SHA-256, MGF1, salt 32)");
  });

  it("names the curve of an EC key", () => {
    const ec = {
      algorithm: { oid: "1.2.840.10045.2.1", name: "ecPublicKey" },
      parameters: {
        rawHex: "06052b81040022",
        parsed: { type: "objectIdentifier", oid: { oid: "1.3.132.0.34", name: "P-384" } },
      },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(ec, salt)).toBe("ecPublicKey (P-384)");
    const unnamed = {
      algorithm: { oid: "1.2.840.10045.2.1", name: "ecPublicKey" },
      parameters: {
        rawHex: "06032b0601",
        parsed: { type: "objectIdentifier", oid: { oid: "1.3.6.1", name: null } },
      },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(unnamed, salt)).toBe("ecPublicKey (1.3.6.1)");
  });

  it("shows the bare name for NULL or absent parameters, the OID without a name", () => {
    const rsa = {
      algorithm: { oid: "1.2.840.113549.1.1.11", name: "sha256WithRSAEncryption" },
      parameters: { rawHex: "0500", parsed: { type: "null" } },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(rsa, salt)).toBe("sha256WithRSAEncryption");
    const ecdsa = {
      algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(ecdsa, salt)).toBe("ecdsa-with-SHA384");
    // Undecoded parameters: the name alone.
    const unknown = {
      algorithm: { oid: "1.2.3.4", name: null },
      parameters: { rawHex: "0401ff" },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(unknown, salt)).toBe("1.2.3.4");
    expect(formatAlgorithm(undefined, salt)).toBeNull();
  });
});

describe("formatGeneralName", () => {
  it("prefixes the type label", () => {
    const dns = { type: "dNSName", value: "leaf.example.test" } satisfies GeneralName;
    expect(formatGeneralName(dns, label)).toBe("DNS: leaf.example.test");
  });

  it("shows an otherName by its known name, else its type OID, else the label", () => {
    // leaf-full's UPN SAN (generator: otherName.1 = 1.3.6.1.4.1.311.20.2.3;UTF8:leaf@example.test).
    const upn = {
      type: "otherName",
      value: "leaf@example.test",
      typeOid: "1.3.6.1.4.1.311.20.2.3",
      typeName: "UPN",
    } satisfies GeneralName;
    expect(formatGeneralName(upn, label)).toBe("UPN: leaf@example.test");
    const { typeName: _, ...unnamed } = upn;
    expect(formatGeneralName(unnamed, label)).toBe("1.3.6.1.4.1.311.20.2.3: leaf@example.test");
    expect(formatGeneralName({ type: "otherName", value: "", rawHex: "a003" }, label)).toBe(
      "Other: a003"
    );
  });
});

describe("formatName / formatAttribute", () => {
  const rdnSequence = [
    {
      attributes: [
        {
          type: { oid: "2.5.4.6", name: "C" },
          value: { string: "US", encoding: "printableString" },
        },
      ],
    },
    {
      attributes: [
        {
          type: { oid: "2.5.4.10", name: "O" },
          value: { string: "Example PKI", encoding: "printableString" },
        },
        {
          type: { oid: "1.2.3.4", name: null },
          value: { string: null, encoding: "unknown", rawHex: "0101ff" },
        },
      ],
    },
  ] satisfies Name["rdnSequence"];
  const name = {
    commonName: null,
    organization: "Example PKI",
    organizationalUnit: null,
    country: "US",
    stateOrProvince: null,
    locality: null,
    rdnSequence,
    rfc4514: "O=Example PKI+1.2.3.4=#0101ff,C=US",
  } satisfies Name;

  it("uses the API's RFC 4514 string", () => {
    expect(formatName(name)).toBe("O=Example PKI+1.2.3.4=#0101ff,C=US");
  });

  it("falls back to the RDNs when the RFC 4514 string is empty", () => {
    expect(formatName({ ...name, rfc4514: "" })).toBe("C=US, O=Example PKI+1.2.3.4=");
    expect(formatName({ ...name, rdnSequence: [], rfc4514: "" })).toBe("");
  });

  it("writes one attribute with its short name or OID", () => {
    expect(formatAttribute(rdnSequence[0]!.attributes[0]!)).toBe("C=US");
    expect(formatAttribute(rdnSequence[1]!.attributes[1]!)).toBe("1.2.3.4=");
  });
});
