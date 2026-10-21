import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { Asn1Line as DumpedAsn1Line } from "../../../src/core/pki/asn1.ts";
import * as schemas from "../../../src/core/summary/schemas.ts";
import { ParsedExtensionValueSchema } from "../../../src/core/summary/schemas.ts";
import type { Asn1Line, ExtensionType } from "../../../src/core/summary/types.ts";

// Case 1 of worker-aia-cdp@5b570aa:tests/web/api-client.test.ts, in core with the schemas (core
// does not depend on http), plus the slice 5a step 1 invariants: the extensionType literals of the
// schema and of the builders are the same 41, there is no "unknown" variant, and the component
// ids are unique.

const literals = ParsedExtensionValueSchema.options.map(
  (option) => option.shape.extensionType.value
);

/** The extensionType literals extensions.ts writes (what slice 5a exit condition 4 compares). */
function builderLiterals(): string[] {
  const source = readFileSync(
    new URL("../../../src/core/summary/extensions.ts", import.meta.url),
    "utf8"
  );
  return [...source.matchAll(/extensionType: "([A-Za-z]+)"/g)].map((match) => match[1] ?? "");
}

/** The `.meta({ id })` of every exported schema of schemas.ts, by export name. */
function componentIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [name, value] of Object.entries(schemas)) {
    const id = value instanceof z.ZodType ? z.globalRegistry.get(value)?.id : undefined;
    if (id !== undefined) {
      ids.set(name, id);
    }
  }
  return ids;
}

describe("ParsedExtensionValueSchema", () => {
  it("validates the discriminant and the required fields of its variant", () => {
    expect(
      ParsedExtensionValueSchema.safeParse({
        extensionType: "cRLNumber",
        number: "12345678901234567890",
      }).success
    ).toBe(true);
    expect(
      ParsedExtensionValueSchema.safeParse({ extensionType: "cRLNumber", number: 1 }).success
    ).toBe(false);
    expect(ParsedExtensionValueSchema.safeParse({ extensionType: "subjectAltName" }).success).toBe(
      false
    );
  });

  // zod 4 reports an unknown discriminant as invalid_union, no longer invalid_union_discriminator
  // (slice 5a step 2, row 4).
  it("has no unknown variant: an unknown discriminant is an invalid_union", () => {
    expect(literals).not.toContain("unknown");
    const result = ParsedExtensionValueSchema.safeParse({ extensionType: "unknown" });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: "invalid_union",
        note: "No matching discriminator",
        path: ["extensionType"],
      }),
    ]);
    expectTypeOf<"unknown">().not.toExtend<ExtensionType>();
  });

  it("has the 41 extensionType literals the builders produce", () => {
    expect(new Set(literals).size).toBe(literals.length);
    expect(literals).toHaveLength(41);
    expect(new Set(builderLiterals())).toEqual(new Set(literals));
    expectTypeOf<ExtensionType>().toEqualTypeOf<(typeof literals)[number]>();
  });
});

describe("component ids", () => {
  it("are unique and name every schema of slice 5a step 1", () => {
    const ids = componentIds();
    expect(new Set(ids.values()).size).toBe(ids.size);
    // An id is the export name without "Schema".
    for (const [name, id] of ids) {
      expect(name).toBe(`${id}Schema`);
    }
    expect([...ids.values()].sort()).toEqual(
      [
        "Name",
        "Time",
        "GeneralName",
        "DistributionPoint",
        "DistributionPointName",
        "AlgorithmIdentifier",
        "SignatureValue",
        "SubjectPublicKeyInfo",
        "Extension",
        "Extensions",
        "TBSCertificate",
        "TBSCertList",
        "RevokedCertificate",
        ...ParsedExtensionValueSchema.options.map((option) => z.globalRegistry.get(option)?.id),
      ].sort()
    );
  });

  // The OpenAPI generator writes discriminator.mapping only when every member has an id.
  it("name every variant of ParsedExtensionValueSchema", () => {
    for (const option of ParsedExtensionValueSchema.options) {
      expect(z.globalRegistry.get(option)?.id).toMatch(/Value$/);
    }
  });
});

it("Asn1LineSchema describes exactly the lines of dumpAsn1", () => {
  expectTypeOf<Asn1Line>().toEqualTypeOf<DumpedAsn1Line>();
});
