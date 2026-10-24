import { describe, expect, it } from "vitest";
import type { CrlSummary } from "../../src/core/catalog.ts";
import { compareFreshness } from "../../src/core/publish.ts";
import type { FreshnessInput } from "../../src/core/publish.ts";

// compareFreshness is a pure function of two catalog summaries: the inputs are literal objects.

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
  it("is created without a current CRL", () => {
    expect(compareFreshness(null, crl(A, "1", DAY_1))).toBe("created");
    expect(compareFreshness(undefined, crl(A, null, DAY_1))).toBe("created");
  });

  it("is unchanged for the same sha256, whatever the summaries say", () => {
    expect(compareFreshness(crl(A, "2", DAY_2), crl(A, "1", DAY_1))).toBe("unchanged");
    expect(compareFreshness(crl(A, null, DAY_1), crl(A, "1", DAY_1))).toBe("unchanged");
  });

  it("is non_orderable when exactly one side has a CRL Number, in both directions", () => {
    expect(compareFreshness(crl(A, "3", DAY_1), crl(B, null, DAY_2))).toBe("non_orderable");
    expect(compareFreshness(crl(A, null, DAY_1), crl(B, "3", DAY_2))).toBe("non_orderable");
  });

  it("orders numbered CRLs by number, over thisUpdate, as numbers beyond 2^53", () => {
    expect(compareFreshness(crl(A, "5", DAY_2), crl(B, "6", DAY_1))).toBe("updated");
    expect(compareFreshness(crl(A, "6", DAY_1), crl(B, "5", DAY_2))).toBe("stale_crl");
    // "10" < "9" as strings.
    expect(compareFreshness(crl(A, "9", DAY_1), crl(B, "10", DAY_1))).toBe("updated");
    // Equal as JavaScript numbers.
    expect(Number(LARGE) === Number(LARGE + 1n)).toBe(true);
    const low = LARGE.toString();
    const high = (LARGE + 1n).toString();
    expect(compareFreshness(crl(A, low, DAY_1), crl(B, high, DAY_1))).toBe("updated");
    expect(compareFreshness(crl(A, high, DAY_1), crl(B, low, DAY_1))).toBe("stale_crl");
  });

  describe.each([
    ["equal numbers", "7"],
    ["no numbers on either side", null],
  ])("with %s, by thisUpdate", (_case, number) => {
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
      expect(compareFreshness(withMs, crl(B, number, "2026-01-02T00:00:00Z"))).toBe("conflict");
      // One second later, but "…:01Z" < "…:00.000Z" as strings.
      expect(compareFreshness(withMs, crl(B, number, "2026-01-02T00:00:01Z"))).toBe("updated");
    });
  });
});
