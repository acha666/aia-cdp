import { describe, expect, it } from "vitest";
import { compareFreshness } from "../../src/core/publish.ts";
import type { FreshnessInput } from "../../src/core/publish.ts";
import type { CrlSummary } from "../../src/core/summary/catalog-summary.ts";

// compareFreshness (slice 4 step 5; C3, M15): a pure function of two catalog summaries, so the
// inputs are literal objects, not fixtures. Rows refer to the table of step 5.

const A = "a".repeat(64);
const B = "b".repeat(64);

/** A whole `current`-shaped record; compareFreshness must only look at sha256, number and time. */
function crl(
  sha256: string,
  crlNumber: string | null,
  thisUpdate: string,
  nextUpdate: string | null = "2026-01-09T00:00:00.000Z"
): FreshnessInput & { summary: CrlSummary } {
  return {
    sha256,
    summary: {
      crlNumber,
      baseCrlNumber: null,
      thisUpdate,
      nextUpdate,
      revokedCount: 0,
      sha1: "0".repeat(40),
      nextPublish: null,
    },
  };
}

const DAY_1 = "2026-01-01T00:00:00.000Z";
const DAY_2 = "2026-01-02T00:00:00.000Z";
const LARGE = 2n ** 100n + 123n;

describe("compareFreshness", () => {
  it("row 0: created without a current CRL", () => {
    expect(compareFreshness(null, crl(A, "1", DAY_1))).toBe("created");
    expect(compareFreshness(undefined, crl(A, null, DAY_1))).toBe("created");
  });

  it("row 1: unchanged for the same sha256, whatever the summaries say", () => {
    expect(compareFreshness(crl(A, "1", DAY_1), crl(A, "1", DAY_1))).toBe("unchanged");
    // Digest first: equal bytes never reach the number or time rows.
    expect(compareFreshness(crl(A, "2", DAY_2), crl(A, "1", DAY_1))).toBe("unchanged");
    expect(compareFreshness(crl(A, null, DAY_1), crl(A, "1", DAY_1))).toBe("unchanged");
  });

  it("row 2: non_orderable when exactly one side has a CRL Number, in both directions", () => {
    expect(compareFreshness(crl(A, "3", DAY_1), crl(B, null, DAY_2))).toBe("non_orderable");
    expect(compareFreshness(crl(A, null, DAY_1), crl(B, "3", DAY_2))).toBe("non_orderable");
  });

  describe("row 3: both numbered", () => {
    it("a higher number is updated, a lower one stale_crl", () => {
      expect(compareFreshness(crl(A, "3", DAY_1), crl(B, "4", DAY_2))).toBe("updated");
      expect(compareFreshness(crl(A, "4", DAY_2), crl(B, "3", DAY_1))).toBe("stale_crl");
    });

    it("the number wins over thisUpdate", () => {
      expect(compareFreshness(crl(A, "5", DAY_2), crl(B, "6", DAY_1))).toBe("updated");
      expect(compareFreshness(crl(A, "6", DAY_1), crl(B, "5", DAY_2))).toBe("stale_crl");
    });

    it("compares numbers, not strings", () => {
      // "10" < "9" as strings.
      expect(compareFreshness(crl(A, "9", DAY_1), crl(B, "10", DAY_1))).toBe("updated");
      expect(compareFreshness(crl(A, "10", DAY_1), crl(B, "9", DAY_1))).toBe("stale_crl");
    });

    it("keeps the precision of numbers beyond 2^53 (2^100 + 123)", () => {
      // Equal as JavaScript numbers.
      expect(Number(LARGE) === Number(LARGE + 1n)).toBe(true);
      const low = LARGE.toString();
      const high = (LARGE + 1n).toString();
      expect(compareFreshness(crl(A, low, DAY_1), crl(B, high, DAY_1))).toBe("updated");
      expect(compareFreshness(crl(A, high, DAY_1), crl(B, low, DAY_1))).toBe("stale_crl");
      expect(compareFreshness(crl(A, low, DAY_1), crl(B, low, DAY_1))).toBe("conflict");
    });
  });

  describe.each([
    ["equal numbers", "7"],
    ["no numbers on either side", null],
  ])("row 4, %s: by thisUpdate", (_case, number) => {
    it("a later thisUpdate is updated, an earlier one stale_crl", () => {
      expect(compareFreshness(crl(A, number, DAY_1), crl(B, number, DAY_2))).toBe("updated");
      expect(compareFreshness(crl(A, number, DAY_2), crl(B, number, DAY_1))).toBe("stale_crl");
    });

    it("the same instant with other bytes is conflict, nextUpdate notwithstanding", () => {
      const current = crl(A, number, DAY_1, "2026-01-08T00:00:00.000Z");
      expect(compareFreshness(current, crl(B, number, DAY_1, "2026-01-08T12:00:00.000Z"))).toBe(
        "conflict"
      );
      expect(compareFreshness(current, crl(B, number, DAY_1, null))).toBe("conflict");
    });

    it("compares instants, not strings: with and without milliseconds", () => {
      const withMs = crl(A, number, "2026-01-02T00:00:00.000Z");
      const withoutMs = crl(B, number, "2026-01-02T00:00:00Z");
      expect(compareFreshness(withMs, withoutMs)).toBe("conflict");
      expect(compareFreshness(withoutMs, withMs)).toBe("conflict");
      // One second later, but "…:01Z" < "…:00.000Z" as strings.
      expect(compareFreshness(withMs, crl(B, number, "2026-01-02T00:00:01Z"))).toBe("updated");
      expect(compareFreshness(crl(B, number, "2026-01-02T00:00:01Z"), withMs)).toBe("stale_crl");
    });
  });

  it("throws on a number or time that is not in the catalog format", () => {
    for (const bad of ["", " 7", "0x10", "-1", "07"]) {
      expect(() => compareFreshness(crl(A, "7", DAY_1), crl(B, bad, DAY_1)), bad).toThrow(
        RangeError
      );
    }
    expect(() => compareFreshness(crl(A, null, DAY_1), crl(B, null, "yesterday"))).toThrow(
      RangeError
    );
  });
});
