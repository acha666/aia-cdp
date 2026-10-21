// Hex helpers (implementation slice 5b step 2).
import { describe, expect, it } from "vitest";
import { formatHex, formatHexGroups, normalizeHexForCopy } from "@/utils/format";

describe("formatHex / formatHexGroups", () => {
  it("groups bytes in upper case with colons by default", () => {
    expect(formatHex("0a1b2c")).toBe("0A:1B:2C");
    expect(formatHexGroups("0a1b2c")).toEqual(["0A", "1B", "2C"]);
  });

  it("takes group size, separator and case", () => {
    expect(formatHex("0a1b2c3d", { groupSize: 4, separator: " " })).toBe("0A1B 2C3D");
    expect(formatHex("0A1B", { uppercase: false, separator: "" })).toBe("0A1B");
    expect(formatHex("0a1b", { uppercase: false })).toBe("0a:1b");
    // A last group may be short (odd-length input is shown as it is, not padded).
    expect(formatHexGroups("abcde", { groupSize: 2 })).toEqual(["AB", "CD", "E"]);
  });

  it("keeps the value as one group for a group size of 0 or less", () => {
    expect(formatHex("0a1b", { groupSize: 0 })).toBe("0A1B");
    expect(formatHexGroups("0a1b", { groupSize: -1 })).toEqual(["0A1B"]);
  });

  it("returns nothing for an empty value", () => {
    expect(formatHexGroups("")).toEqual([]);
    expect(formatHex("")).toBe("");
  });
});

describe("normalizeHexForCopy", () => {
  it("strips 0x, colons, spaces and dashes and upper-cases", () => {
    expect(normalizeHexForCopy("0A:1B:2C")).toBe("0A1B2C");
    expect(normalizeHexForCopy("  0x0a 1b-2c\n")).toBe("0A1B2C");
    expect(normalizeHexForCopy("0Xff")).toBe("FF");
  });
});
