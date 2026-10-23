// The render blocks of decoded extension values: optional parts and subtree ranges. The blocks of
// each kind as the page shows them are in components.test.ts (ExtensionView).
import { describe, expect, it } from "vitest";
import type { GeneralName } from "@/client/types";
import en from "@/locales/en.json";
import { describeExtension, describeSubtree } from "@/utils/extension-blocks";
import type { Block, ExtensionContext } from "@/utils/extension-blocks";

const FIELDS: Record<string, string> = en.extension.fields;

const ctx: ExtensionContext = {
  field: (key) => FIELDS[key] ?? key,
  nameLabel: (type) => en.extension.generalName[type],
  time: (iso) => (iso === undefined ? "N/A" : `time(${iso})`),
  yesNo: (value) => (value ? "Yes" : "No"),
};

const rows = (...list: [label: string, value: string, hex?: boolean][]): Block => ({
  kind: "rows",
  rows: list.map(([label, value, hex]) =>
    hex === undefined ? { label, value } : { label, value, hex }
  ),
});

describe("describeExtension", () => {
  it("omits the optional parts that are absent", () => {
    const aki = "3F1C2B4D5E6F708192A3B4C5D6E7F8091A2B3C4D";
    expect(describeExtension({ extensionType: "basicConstraints", cA: false }, ctx)).toEqual([
      rows(["CA", "No"]),
    ]);
    expect(
      describeExtension({ extensionType: "authorityKeyIdentifier", keyIdentifier: aki }, ctx)
    ).toEqual([rows(["Key ID", aki, true])]);
    expect(describeExtension({ extensionType: "nameConstraints" }, ctx)).toEqual([]);
    expect(
      describeExtension(
        { extensionType: "msCertificateTemplate", templateId: { oid: "1.2.3", name: "T" } },
        ctx
      )
    ).toEqual([rows(["Template OID", "T (1.2.3)"], ["Template version", "0.0"])]);
    expect(
      describeExtension({ extensionType: "policyConstraints", inhibitPolicyMapping: 2 }, ctx)
    ).toEqual([rows(["Inhibit policy mapping", "2"])]);
  });

  it("writes subtree ranges as [min–max] and only when given", () => {
    const dns: GeneralName = { type: "dNSName", value: "example.test" };
    expect(describeSubtree({ base: dns }, ctx)).toBe("DNS: example.test");
    expect(describeSubtree({ base: dns, minimum: 0 }, ctx)).toBe("DNS: example.test [0]");
    expect(describeSubtree({ base: dns, maximum: 2 }, ctx)).toBe("DNS: example.test [0–2]");
    expect(describeSubtree({ base: dns, minimum: 1, maximum: 3 }, ctx)).toBe(
      "DNS: example.test [1–3]"
    );
  });
});
