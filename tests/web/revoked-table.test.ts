// The revoked certificates of a CRL target (implementation slice 5b step 6). The API sends every
// entry (slice 5a dropped the old builder's 10-entry pages), so the table shows a CRL's whole list
// and pages it itself at 200 rows. The fourth case of worker-aia-cdp@5b570aa:tests/web/
// components.test.ts ("CRL details disclose the actual partial list size") becomes the second
// and fourth cases here: nothing is cut off, and a page says which rows of how many it shows.
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { revokedEntries, time } from "./helpers";
import type { RevokedCertificate, RevokedCertificates } from "@/client/types";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function render(revoked: RevokedCertificates | null, locale: AppLocale = "en") {
  wrapper = mount(RevokedTable, {
    props: { revoked },
    global: { plugins: [createAppI18n(locale)] },
  });
  return wrapper;
}

function list(items: RevokedCertificate[]): RevokedCertificates {
  return { count: items.length, items };
}

const serials = (table: VueWrapper) => table.findAll("tbody tr").map((row) => row.get("td").text());

describe("RevokedTable", () => {
  it("renders no table for a target without a current CRL", () => {
    const table = render(null);
    expect(table.find("table").exists()).toBe(false);
    expect(table.text()).toBe("Not published");
  });

  it("shows an empty state, not an empty table, for a CRL without entries", () => {
    const table = render(list([]), "zh-CN");
    expect(table.find("table").exists()).toBe(false);
    expect(table.get('[data-testid="revoked-empty"]').text()).toBe("没有吊销的证书。");
  });

  it("shows all 15 entries of a CRL on one page", () => {
    const table = render(list(revokedEntries(15)));
    expect(serials(table)).toHaveLength(15);
    expect(serials(table).at(-1)).toBe("000F");
    expect(table.find('[data-testid="revoked-range"]').exists()).toBe(false);
    // The header row sticks to the top of the scrolling box.
    expect(table.get("thead").classes()).toContain("sticky");
  });

  it("pages 201 entries as 200 + 1", async () => {
    const table = render(list(revokedEntries(201)));
    expect(serials(table)).toHaveLength(200);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 201");
    expect(table.get('[data-testid="previous-page"]').attributes("disabled")).toBeDefined();

    await table.get('[data-testid="next-page"]').trigger("click");
    expect(serials(table)).toEqual(["00C9"]);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("201–201 of 201");
    expect(table.get('[data-testid="next-page"]').attributes("disabled")).toBeDefined();

    // Another list (a refetch) starts again on the first page.
    await table.setProps({ revoked: list(revokedEntries(250)) });
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 250");
  });

  it("fills reason, invalidity date and indirect issuer from the entry extensions", () => {
    // leaf-revoked in crls/issuing-ca-1/full-01: keyCompromise with an invalidity date.
    const entry: RevokedCertificate = {
      userCertificate: { hex: "2002" },
      // Noon UTC: the same day in every time zone the test may run in.
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
    const cells = render(list([entry, ...revokedEntries(1)]))
      .findAll("tbody tr")
      .map((row) => row.findAll("td").map((cell) => cell.text()));

    expect(cells[0]![0]).toBe("2002");
    expect(cells[0]![1]).toMatch(/^Jan 01, 2026 \d\d:\d\d:00 \(UTC/);
    expect(cells[0]![2]).toBe("keyCompromise");
    expect(cells[0]![3]).toMatch(/^Dec 31, 2025/);
    expect(cells[0]![4]).toBe("DNS: ca.example.test");
    expect(cells[1]!.slice(2)).toEqual(["—", "—", "—"]);
  });
});
