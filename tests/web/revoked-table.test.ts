// The revoked certificates of a CRL target. The API sends every entry; the table pages them
// itself at 200 rows and says which rows of how many a page shows.
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { revokedEntries, time } from "./helpers";
import type { RevokedCertificate, RevokedCertificates } from "@/client/types";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

function render(revoked: RevokedCertificates, locale: AppLocale = "en") {
  return mount(RevokedTable, {
    props: { revoked },
    attachTo: document.body,
    global: { plugins: [createAppI18n(locale)] },
  });
}

function list(items: RevokedCertificate[]): RevokedCertificates {
  return { count: items.length, items };
}

/** The data cells of each body row; the first cell holds the extensions toggle. */
const rowTexts = (table: VueWrapper) =>
  table.findAll("tbody tr").map((row) =>
    row
      .findAll("td")
      .slice(1)
      .map((cell) => cell.text())
  );

const serials = (table: VueWrapper) => rowTexts(table).map((row) => row[0]);

describe("RevokedTable", () => {
  it("shows an empty state, not an empty table, for a CRL without entries", () => {
    const table = render(list([]), "zh-CN");
    expect(table.find("table").exists()).toBe(false);
    expect(table.get('[data-testid="revoked-empty"]').text()).toBe("没有吊销的证书。");
  });

  it("shows exactly 200 entries on one page, without a pager", () => {
    const table = render(list(revokedEntries(200)));
    expect(serials(table)).toHaveLength(200);
    expect(serials(table).at(-1)).toBe("00C8");
    expect(table.find('[data-testid="revoked-range"]').exists()).toBe(false);
    expect(table.find('[data-testid="next-page"]').exists()).toBe(false);
  });

  it("pages 201 entries as 200 + 1", async () => {
    const table = render(list(revokedEntries(201)));
    expect(serials(table)).toHaveLength(200);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 201");
    expect(table.get('[data-testid="previous-page"]').attributes("aria-disabled")).toBe("true");

    await table.get('[data-testid="next-page"]').trigger("click");
    expect(serials(table)).toEqual(["00C9"]);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("201–201 of 201");
    expect(table.get('[data-testid="next-page"]').attributes("aria-disabled")).toBe("true");

    // Another list (a refetch) starts again on the first page.
    await table.setProps({ revoked: list(revokedEntries(250)) });
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 250");
  });

  it("fills reason, invalidity date and indirect issuer from the entry extensions", () => {
    // Dates show in the browser's time zone (UTC+12 and later is already Jan 02).
    vi.stubEnv("TZ", "UTC");
    // leaf-revoked in crls/issuing-ca-1/full-01: keyCompromise with an invalidity date.
    const entry: RevokedCertificate = {
      userCertificate: { hex: "2002" },
      revocationDate: time("2026-01-01T12:00:00Z"),
      crlEntryExtensions: {
        count: 3,
        items: [
          {
            extnID: { oid: "2.5.29.21", name: "cRLReason" },
            critical: false,
            extnValue: { hex: "0a0101", byteLength: 3 },
            parseStatus: "parsed",
            parsed: { extensionType: "cRLReason", code: 1, name: "keyCompromise" },
          },
          {
            extnID: { oid: "2.5.29.24", name: "invalidityDate" },
            critical: false,
            extnValue: { hex: "180f", byteLength: 17 },
            parseStatus: "parsed",
            parsed: { extensionType: "invalidityDate", date: time("2025-12-31T12:00:00Z") },
          },
          {
            extnID: { oid: "2.5.29.29", name: "certificateIssuer" },
            critical: true,
            extnValue: { hex: "3000", byteLength: 2 },
            parseStatus: "parsed",
            parsed: {
              extensionType: "certificateIssuer",
              names: [{ type: "dNSName", value: "ca.example.test" }],
            },
          },
        ],
      },
    };
    const cells = rowTexts(render(list([entry, ...revokedEntries(1)])));

    expect(cells[0]![0]).toBe("2002");
    expect(cells[0]![1]).toBe("Jan 01, 2026 12:00:00 (UTC)");
    expect(cells[0]![2]).toBe("keyCompromise");
    expect(cells[0]![3]).toBe("Dec 31, 2025 12:00:00 (UTC)");
    expect(cells[0]![4]).toBe("DNS: ca.example.test");
    expect(cells[1]!.slice(2)).toEqual(["—", "—", "—"]);
  });

  it("expands a row with entry extensions into all of them, the hold instruction too", async () => {
    // The certificateHold entry of crls/issuing-ca-2/full-01.
    const entry: RevokedCertificate = {
      userCertificate: { hex: "3000" },
      revocationDate: time("2025-12-20T00:00:00Z"),
      crlEntryExtensions: {
        count: 2,
        items: [
          {
            extnID: { oid: "2.5.29.21", name: "CRL Reason Code" },
            critical: false,
            extnValue: { hex: "0a0106", byteLength: 3 },
            parseStatus: "parsed",
            parsed: { extensionType: "cRLReason", code: 6, name: "certificateHold" },
          },
          {
            extnID: { oid: "2.5.29.23", name: "Hold Instruction Code" },
            critical: false,
            extnValue: { hex: "06072a8648ce380203", byteLength: 9 },
            parseStatus: "parsed",
            parsed: {
              extensionType: "holdInstructionCode",
              instruction: { oid: "1.2.840.10040.2.3", name: "holdInstructionReject" },
            },
          },
        ],
      },
    };
    const table = render(list([entry, ...revokedEntries(1)]));
    const [held, plain] = table.findAll("tbody tr");
    expect(plain!.find("button").exists()).toBe(false);
    const toggle = held!.get('[data-testid="entry-toggle"]');
    expect(toggle.attributes("aria-label")).toBe("Show entry extensions");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    const detail = table.findAll("tbody tr")[1]!;
    expect(detail.findAll("[data-oid]").map((item) => item.attributes("data-oid"))).toEqual([
      "2.5.29.21",
      "2.5.29.23",
    ]);
    await detail.get('[data-oid="2.5.29.23"] button').trigger("click");
    expect(detail.text()).toContain("holdInstructionReject (1.2.840.10040.2.3)");

    await toggle.trigger("click");
    expect(serials(table)).toEqual(["3000", "0001"]);
  });
});
