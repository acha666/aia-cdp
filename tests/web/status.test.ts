// Status rules of the badges. The AD CS times come from the synthetic fixture
// crls/issuing-ca-1/full-adcs (manifest.json).
import { describe, expect, it } from "vitest";
import manifest from "../fixtures/pki/manifest.json";
import { computeCertificateStatus, computeCrlStatus, needsAttention } from "@/utils/status";
import type { CrlStatusState } from "@/utils/status";

const start = "2026-01-01T00:00:00Z";
const end = "2026-01-11T00:00:00Z";
const now = Date.parse("2026-01-05T00:00:00Z");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const adcsFull = manifest.crls.find((crl) => crl.file === "crls/issuing-ca-1/full-adcs.der")!;
const ADCS = { ...adcsFull, nextUpdate: adcsFull.nextUpdate!, nextPublish: adcsFull.nextPublish! };

describe.each([
  ["computeCertificateStatus", computeCertificateStatus],
  ["computeCrlStatus", computeCrlStatus],
])("%s", (_, status) => {
  it("is unknown for missing, malformed or inverted validity windows", () => {
    for (const [from, until] of [
      [null, null],
      [start, null],
      [null, end],
      ["invalid", end],
      [start, "invalid"],
      [end, start],
    ]) {
      expect(status(from, until, now).state).toBe("unknown");
    }
  });

  it("is not yet valid before the start and expired after the end", () => {
    expect(status(start, end, Date.parse(start) - 1).state).toBe("not-yet-valid");
    expect(status(start, end, Date.parse(end) + 1500).state).toBe("expired");
  });
});

describe("computeCrlStatus", () => {
  it("is unknown without nextUpdate, even with Next CRL Publish, or with an empty window", () => {
    expect(computeCrlStatus(start, undefined, now, "2026-01-02T00:00:00Z").state).toBe("unknown");
    expect(computeCrlStatus(start, start, now).state).toBe("unknown");
  });

  it("is expired only after nextUpdate (inclusive bound) and counts whole seconds", () => {
    expect(computeCrlStatus(start, end, Date.parse(end))).toEqual({
      state: "stale",
      expiresIn: 0,
    });
    expect(computeCrlStatus(start, end, Date.parse(end) + 1500)).toEqual({
      state: "expired",
      expiredAgo: 1,
    });
  });

  it("is stale with less than 20% left without Next CRL Publish", () => {
    // 10 days: the 80% point is 8 days after thisUpdate.
    const eightDays = Date.parse(start) + 8 * DAY;
    expect(computeCrlStatus(start, end, now).state).toBe("current");
    expect(computeCrlStatus(start, end, eightDays).state).toBe("current");
    expect(computeCrlStatus(start, end, eightDays + 1).state).toBe("stale");
  });

  it("with Next CRL Publish, is stale only more than an hour after it (AD CS)", () => {
    const publish = Date.parse(ADCS.nextPublish);
    const status = (at: number) =>
      computeCrlStatus(ADCS.thisUpdate, ADCS.nextUpdate, at, ADCS.nextPublish).state;

    // Past the 80% point but before Next CRL Publish: current.
    const eightyPercent =
      Date.parse(ADCS.thisUpdate) +
      0.8 * (Date.parse(ADCS.nextUpdate) - Date.parse(ADCS.thisUpdate));
    expect(status(eightyPercent + HOUR)).toBe("current");
    expect(status(publish + HOUR)).toBe("current");
    expect(status(publish + HOUR + 1)).toBe("stale");
    // nextUpdate still wins: expired after it.
    expect(status(Date.parse(ADCS.nextUpdate) + 1)).toBe("expired");
  });
});

describe("computeCertificateStatus", () => {
  it("is still valid at notAfter (expiring there) and expired one millisecond later", () => {
    expect(computeCertificateStatus(start, end, Date.parse(end))).toEqual({
      state: "expiring",
      expiresIn: 0,
    });
    expect(computeCertificateStatus(start, end, Date.parse(end) + 1).state).toBe("expired");
  });

  it("is expiring with less than 10% of the validity period left", () => {
    // 10 days: expiring once less than one day remains.
    const oneDayLeft = Date.parse(end) - DAY;
    expect(computeCertificateStatus(start, end, oneDayLeft)).toEqual({
      state: "valid",
      expiresIn: DAY / 1000,
    });
    expect(computeCertificateStatus(start, end, oneDayLeft + 1).state).toBe("expiring");
  });

  it("reports the distance to notBefore of a certificate that is not yet valid", () => {
    expect(computeCertificateStatus(start, end, Date.parse(start) - 61_000)).toEqual({
      state: "not-yet-valid",
      startsIn: 61,
    });
  });
});

describe("needsAttention", () => {
  it("counts stale, expired and unknown targets", () => {
    const states: CrlStatusState[] = [
      "current",
      "stale",
      "expired",
      "not-yet-valid",
      "unknown",
      "unpublished",
    ];
    expect(states.filter(needsAttention)).toEqual(["stale", "expired", "unknown"]);
  });
});
