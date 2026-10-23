// The algorithm names of the X.509 views. Shapes are the API's (@/client/types); OID names are
// those of src/core/pki/constants.ts. The page tests show the RSASSA-PSS and named-curve forms.
import { describe, expect, it } from "vitest";
import type { AlgorithmIdentifier } from "@/client/types";
import { formatAlgorithm } from "@/utils/x509";

const salt = (length: number) => `salt ${String(length)}`;

describe("formatAlgorithm", () => {
  it("shows the bare name for NULL, absent or undecoded parameters, the OID without a name", () => {
    const rsa = {
      algorithm: { oid: "1.2.840.113549.1.1.11", name: "sha256WithRSAEncryption" },
      parameters: { rawHex: "0500", parsed: { type: "null" } },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(rsa, salt)).toBe("sha256WithRSAEncryption");
    const ecdsa = {
      algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(ecdsa, salt)).toBe("ecdsa-with-SHA384");
    const unknown = {
      algorithm: { oid: "1.2.3.4", name: null },
      parameters: { rawHex: "0401ff" },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(unknown, salt)).toBe("1.2.3.4");
    expect(formatAlgorithm(undefined, salt)).toBeNull();
  });

  it("names an unnamed curve by its OID", () => {
    const unnamed = {
      algorithm: { oid: "1.2.840.10045.2.1", name: "ecPublicKey" },
      parameters: {
        rawHex: "06032b0601",
        parsed: { type: "objectIdentifier", oid: { oid: "1.3.6.1", name: null } },
      },
    } satisfies AlgorithmIdentifier;
    expect(formatAlgorithm(unnamed, salt)).toBe("ecPublicKey (1.3.6.1)");
  });
});
