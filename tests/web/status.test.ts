// Status rules of the badges (implementation slice 5b step 2, owner answer 2). The first two cases
// are worker-aia-cdp@5b570aa:tests/web/status.test.ts as they were, moved from node:test to vitest
// (whose `assert` replaces node:assert: the web program has no Node types). The AD CS times come
// from the synthetic fixtures crls/issuing-ca-1/{full,delta}-adcs (manifest.json).
import { assert, describe, expect, it, test } from "vitest";
import manifest from "../fixtures/pki/manifest.json";
import type { CrlTargetListItem } from "@/client/types";
import {
  computeCertificateStatus,
  computeCrlStatus,
  computeTargetStatus,
  needsAttention,
} from "@/utils/status";
import type { CrlStatusState } from "@/utils/status";

const start = "2026-01-01T00:00:00Z";
const end = "2026-01-11T00:00:00Z";
const now = Date.parse("2026-01-05T00:00:00Z");

test("missing, malformed or inverted dates never imply valid certificates or current CRLs", () => {
  for (const status of [computeCertificateStatus, computeCrlStatus]) {
    for (const [from, until] of [
      [null, null],
      [start, null],
      [null, end],
      ["invalid", end],
      [start, "invalid"],
      [end, start],
    ]) {
      assert.equal(status(from, until, now).state, "unknown");
    }
    assert.equal(status(start, end, Date.parse(start) - 1).state, "not-yet-valid");
    assert.equal(status(start, end, Date.parse(end) + 1).state, "expired");
  }
});

test("known validity windows preserve valid, current and nearing-expiry states", () => {
  assert.equal(computeCertificateStatus(start, end, now).state, "valid");
  assert.equal(computeCrlStatus(start, end, now).state, "current");
  assert.equal(computeCrlStatus(start, end, Date.parse("2026-01-10T00:00:00Z")).state, "stale");
  assert.equal(computeCrlStatus(start, start, now).state, "unknown");
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A manifest CRL with nextUpdate and Next CRL Publish (the AD CS fixtures). */
function adcsCrl(file: string) {
  const entry = manifest.crls.find((crl) => crl.file === file);
  if (entry === undefined || entry.nextUpdate === null || entry.nextPublish === null) {
    throw new Error(`${file} is not an AD CS CRL with nextUpdate and Next CRL Publish`);
  }
  return { ...entry, nextUpdate: entry.nextUpdate, nextPublish: entry.nextPublish };
}

type Summary = NonNullable<CrlTargetListItem["current"]>["summary"];

/** A target's `current` as the list route returns it for a manifest CRL (size and SHA-1 made up). */
function current(
  crl: ReturnType<typeof adcsCrl>,
  times: Partial<Pick<Summary, "nextUpdate" | "nextPublish">> = {}
) {
  return {
    sha256: crl.sha256,
    size: 1024,
    publishedAt: crl.thisUpdate,
    summary: {
      crlNumber: crl.crlNumber,
      baseCrlNumber: crl.baseCrlNumber,
      thisUpdate: crl.thisUpdate,
      nextUpdate: crl.nextUpdate,
      revokedCount: crl.revoked,
      sha1: "0".repeat(40),
      nextPublish: crl.nextPublish,
      ...times,
    },
  } satisfies NonNullable<CrlTargetListItem["current"]>;
}

describe("computeCrlStatus", () => {
  it("is unknown without nextUpdate, whatever else the CRL carries", () => {
    expect(computeCrlStatus(start, null, now).state).toBe("unknown");
    expect(computeCrlStatus(start, undefined, now, "2026-01-02T00:00:00Z").state).toBe("unknown");
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

  it("keeps the 80% rule without Next CRL Publish (stale with less than 20% left)", () => {
    // 10 days: the 80% point is 8 days after thisUpdate.
    const eightDays = Date.parse(start) + 8 * DAY;
    expect(computeCrlStatus(start, end, eightDays).state).toBe("current");
    expect(computeCrlStatus(start, end, eightDays + 1).state).toBe("stale");
  });

  it("with Next CRL Publish, is stale only more than an hour after it (AD CS full CRL)", () => {
    const crl = adcsCrl("crls/issuing-ca-1/full-adcs.der");
    const publish = Date.parse(crl.nextPublish);
    const status = (at: number) =>
      computeCrlStatus(crl.thisUpdate, crl.nextUpdate, at, crl.nextPublish).state;

    // Past the 80% point (stale under the old rule) but before Next CRL Publish: current.
    const eightyPercent =
      Date.parse(crl.thisUpdate) + 0.8 * (Date.parse(crl.nextUpdate) - Date.parse(crl.thisUpdate));
    expect(computeCrlStatus(crl.thisUpdate, crl.nextUpdate, eightyPercent + HOUR).state).toBe(
      "stale"
    );
    expect(status(eightyPercent + HOUR)).toBe("current");
    expect(status(publish)).toBe("current");
    // Exactly one hour after Next CRL Publish is still current; one millisecond later it is stale.
    expect(status(publish + HOUR)).toBe("current");
    expect(status(publish + HOUR + 1)).toBe("stale");
    // nextUpdate still wins: expired after it.
    expect(status(Date.parse(crl.nextUpdate) + 1)).toBe("expired");
  });

  it("applies the same rule to the AD CS delta CRL", () => {
    const crl = adcsCrl("crls/issuing-ca-1/delta-adcs.der");
    const publish = Date.parse(crl.nextPublish);
    const status = (at: number) =>
      computeCrlStatus(crl.thisUpdate, crl.nextUpdate, at, crl.nextPublish).state;
    expect(status(Date.parse(manifest.now))).toBe("current");
    expect(status(publish + HOUR)).toBe("current");
    expect(status(publish + HOUR + 1)).toBe("stale");
  });
});

describe("computeTargetStatus", () => {
  it("is unpublished without a current CRL", () => {
    expect(computeTargetStatus(null, now)).toEqual({ state: "unpublished" });
  });

  it("reads thisUpdate, nextUpdate and nextPublish from the current summary", () => {
    const crl = adcsCrl("crls/issuing-ca-1/full-adcs.der");
    const publish = Date.parse(crl.nextPublish);
    expect(computeTargetStatus(current(crl), publish + HOUR).state).toBe("current");
    expect(computeTargetStatus(current(crl), publish + HOUR + 1).state).toBe("stale");
    // Without Next CRL Publish the 80% rule applies: stale well before that time.
    expect(computeTargetStatus(current(crl, { nextPublish: null }), publish).state).toBe("stale");
    expect(computeTargetStatus(current(crl, { nextUpdate: null }), publish).state).toBe("unknown");
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

  it("puts the threshold two years before the end of a 20-year root", () => {
    const root = manifest.certificates.find((certificate) => certificate.name === "root-ca")!;
    expect(root.notBefore).toBe("2025-01-01T00:00:00Z");
    expect(root.notAfter).toBe("2045-01-01T00:00:00Z");
    const status = (at: string) =>
      computeCertificateStatus(root.notBefore, root.notAfter, Date.parse(at)).state;
    expect(status(manifest.now)).toBe("valid");
    // 7305 days: 730.5 days before the end, i.e. 2043-01-01T12:00:00Z.
    expect(status("2043-01-01T12:00:00Z")).toBe("valid");
    expect(status("2043-01-01T12:00:01Z")).toBe("expiring");
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
