// The three pages on a stubbed fetch (implementation slice 5b step 6): what the overview, a
// certificate and a CRL target show, their loading / missing / unpublished states, and the shell.
// Bodies come from ./helpers (fixture facts from tests/fixtures/pki); the clock is manifest.now
// unless a case moves it.
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises } from "@vue/test-utils";
import type { DOMWrapper, VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  certificateItem,
  deferred,
  envelope,
  issuingDeltaDetail,
  issuingFullDetail,
  mountApp,
  NOW,
  RSASSA_PSS,
  rootDetail,
  STATS,
  stubApi,
  TARGET_IDS,
  targetItems,
} from "./helpers";
import type { Handler } from "./helpers";
import type { CertificateList } from "@/client/types";
import { Toaster } from "@/components/ui/sonner";

let wrapper: VueWrapper | undefined;
let queryClient: QueryClient | undefined;

beforeEach(() => {
  // Only Date: the query timers and Vue's scheduler keep running.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  queryClient?.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function open(path: string, routes: Record<string, Handler>, locale?: "en" | "zh-CN") {
  const api = stubApi(routes);
  const mounted = await mountApp(path, locale);
  ({ wrapper, queryClient } = mounted);
  return { ...mounted, api };
}

const ROOT = rootDetail({
  label: "Root CA",
  targets: [{ targetId: TARGET_IDS.rootFull, kind: "full", label: "Root CA" }],
});

const CERTIFICATES = [
  certificateItem("root-ca", { label: "Root CA" }),
  certificateItem("issuing-ca-1"),
  certificateItem("issuing-ca-2", {
    summary: { ...certificateItem("issuing-ca-2").summary, subjectCN: null },
    downloads: [],
  }),
] satisfies CertificateList;

const OVERVIEW = {
  "GET /api/v1/stats": () => Response.json(STATS),
  "GET /api/v1/certificates": () => Response.json(CERTIFICATES),
  "GET /api/v1/crls": () => Response.json(targetItems()),
};

function cells(row: DOMWrapper<Element>): string[] {
  return row.findAll("td").map((cell) => cell.text());
}

function rows(page: VueWrapper, table: string): DOMWrapper<Element>[] {
  return page.get(`[data-testid="${table}"]`).findAll("tbody tr");
}

/** The [term, value] pairs of the description lists in `element`. */
function definitions(element: Pick<DOMWrapper<Element>, "findAll">): [string, string][] {
  const values = element.findAll("dd");
  return element.findAll("dt").map((term, index) => [term.text(), values[index]!.text()]);
}

function stat(page: VueWrapper, key: string): string {
  return page.get(`[data-stat="${key}"] [data-testid="stat-value"]`).text();
}

/** The levels of the page's headings in document order (h1 → 1, …). */
function headingLevels(page: VueWrapper): number[] {
  return page
    .findAll("main h1, main h2, main h3, main h4, main h5, main h6")
    .map((heading) => Number(heading.element.tagName.slice(1)));
}

/** One h1 first, and no level skipped on the way down. */
function expectHeadingOutline(page: VueWrapper) {
  const levels = headingLevels(page);
  expect(levels[0]).toBe(1);
  levels.slice(1).forEach((level, index) => {
    expect(level, `heading ${String(index + 2)} of ${levels.join(",")}`).toBeGreaterThan(1);
    expect(level, `heading ${String(index + 2)} of ${levels.join(",")}`).toBeLessThanOrEqual(
      levels[index]! + 1
    );
  });
}

/** Tab panels keep a visible focus ring (Reka makes them tab stops). */
function expectFocusRing(panel: Pick<DOMWrapper<Element>, "classes">) {
  expect(panel.classes()).toEqual(
    expect.arrayContaining(["focus-visible:ring-3", "focus-visible:ring-ring/50"])
  );
}

async function selectTab(page: VueWrapper, label: RegExp) {
  const trigger = page.findAll('[role="tab"]').find((tab) => label.test(tab.text()));
  if (trigger === undefined) {
    throw new Error(`No tab ${String(label)}`);
  }
  await trigger.trigger("mousedown", { button: 0 });
  await flushPromises();
}

describe("App shell", () => {
  it("shows VITE_SITE_NAME in the header and the page in the title", async () => {
    const { wrapper } = await open("/", OVERVIEW);

    expect(wrapper.get("header").text()).toContain("Test PKI");
    expect(wrapper.get('[data-testid="site-name"]').text()).toBe("Test PKI");
    expect(document.title).toBe("Overview · Test PKI");
    expect(wrapper.get("footer").text()).not.toMatch(/Cloudflare/);
    // At the top: at the bottom right a toast covered the upload card's submit button.
    expect(wrapper.findComponent(Toaster).props("position")).toBe("top-center");
  });
});

describe("OverviewPage", () => {
  it("shows the counts, the certificates and the targets", async () => {
    const { wrapper } = await open("/", OVERVIEW);

    expect(stat(wrapper, "certificates")).toBe("2");
    expect(stat(wrapper, "targets")).toBe("3");
    expect(stat(wrapper, "published")).toBe("2");
    expect(stat(wrapper, "revocations")).toBe("2");
    expect(stat(wrapper, "attention")).toBe("0");

    // Sorted by display name: label, else subject CN, else "Unknown Certificate".
    const certificates = rows(wrapper, "certificate-table");
    expect(certificates.map((row) => row.get("a").text())).toEqual([
      "Example Issuing CA 01 (RSA)",
      "Root CA",
      "Unknown Certificate",
    ]);
    expect(certificates[1]!.get("a").attributes("href")).toBe(
      `/certificates/${CERTIFICATES[0]!.id}`
    );
    expect(certificates[1]!.text()).toContain("Example Root CA (ECC P-384)");
    expect(certificates[0]!.get('[data-state="valid"]').text()).toBe("Valid");
    // The time left shows while valid.
    expect(certificates[0]!.get('[data-testid="remaining"]').text()).toBe("in 3,284 days");
    expect(cells(certificates[2]!).at(-1)).toBe("—");

    // By label, full before delta (the API sends them by id, the delta first); the unpublished
    // delta has dashes, not 0.
    const targets = rows(wrapper, "crl-target-table");
    expect(targets.map((row) => row.attributes("data-id"))).toEqual([
      TARGET_IDS.issuingFull,
      TARGET_IDS.issuingDelta,
      TARGET_IDS.rootFull,
    ]);
    expect(targets.map((row) => row.get("[data-kind]").attributes("data-kind"))).toEqual([
      "full",
      "delta",
      "full",
    ]);
    expect(targets[0]!.get('[data-testid="crl-number"]').text()).toBe("#19");
    expect(targets[0]!.get('[data-testid="revoked-count"]').text()).toBe("2");
    expect(targets[0]!.find('[data-state="current"]').exists()).toBe(true);
    expect(targets[0]!.get('[data-testid="remaining"]').text()).toBe("in 7 days");
    expect(targets[1]!.get('[data-testid="crl-number"]').text()).toBe("—");
    expect(targets[1]!.get('[data-testid="revoked-count"]').text()).toBe("—");
    expect(targets[1]!.get('[data-state="unpublished"]').text()).toBe("Not published");
    expect(targets[1]!.find('[data-testid="remaining"]').exists()).toBe(false);
    // Nothing to download yet: its paths answer 404 until a CRL is published.
    expect(targets[1]!.find("a[download]").exists()).toBe(false);
    expect(cells(targets[1]!).at(-1)).toBe("—");
    expect(targets[0]!.findAll("a[download]")).toHaveLength(2);
  });

  it("keeps name, kind and status on a phone and hides the secondary columns below sm", async () => {
    const { wrapper } = await open("/", OVERVIEW);

    const shown = (table: string) =>
      wrapper
        .get(`[data-testid="${table}"]`)
        .findAll("thead th")
        .map((head) => [head.text(), !head.classes().includes("hidden")]);
    expect(shown("certificate-table")).toEqual([
      ["Name", true],
      ["Issuer", false],
      ["Validity", false],
      ["Status", true],
      ["Downloads", false],
    ]);
    expect(shown("crl-target-table")).toEqual([
      ["Label", true],
      ["Kind", true],
      ["CRL number", false],
      ["This update – next update", false],
      ["Revoked", false],
      ["Status", true],
      ["Downloads", false],
    ]);
    // Hidden columns come back from sm up, in the head and in every row.
    for (const table of ["certificate-table", "crl-target-table"]) {
      const hidden = wrapper.get(`[data-testid="${table}"]`).findAll("th.hidden, td.hidden");
      expect(hidden.length).toBeGreaterThan(0);
      expect(hidden.every((cell) => cell.classes().includes("sm:table-cell"))).toBe(true);
      const columns = rows(wrapper, table).map((row) => row.findAll("td.hidden").length);
      expect(new Set(columns).size).toBe(1);
    }
  });

  it("counts stale, expired and unknown targets as needing attention, with the badges' clock", async () => {
    // An hour and a half after full-adcs's Next CRL Publish: stale, not yet expired.
    vi.setSystemTime(new Date("2026-01-10T13:30:00Z"));
    const { wrapper } = await open("/", OVERVIEW);

    expect(stat(wrapper, "attention")).toBe("1");
    const stale = rows(wrapper, "crl-target-table")[0]!;
    expect(stale.find('[data-state="stale"]').exists()).toBe(true);
    // Relative times only while current.
    expect(stale.find('[data-testid="remaining"]').exists()).toBe(false);
  });

  it("shows the time left of a certificate in the last tenth of its validity", async () => {
    // Five months before issuing-ca-1 and -2 expire (2035-01-01): under a tenth of ten years.
    vi.setSystemTime(new Date("2034-08-01T00:00:00Z"));
    const { wrapper } = await open("/", OVERVIEW);

    const issuing = rows(wrapper, "certificate-table")[0]!;
    expect(issuing.get('[data-state="expiring"]').text()).toBe("Expiring");
    expect(issuing.get('[data-testid="remaining"]').text()).toBe("in 153 days");
  });

  it("shows unknown revocations when no full CRL is published", async () => {
    const { wrapper } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/stats": () => Response.json({ ...STATS, totalRevocations: null }),
    });

    expect(stat(wrapper, "revocations")).toBe("Unknown");
  });

  it("shows skeletons only before the first answer, then keeps the list while refetching", async () => {
    const first = deferred<Response>();
    const again = deferred<Response>();
    let requests = 0;
    const { wrapper, queryClient } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/certificates": () => {
        requests += 1;
        return requests === 1 ? first.promise : again.promise;
      },
    });
    expect(rows(wrapper, "certificate-table").map((row) => row.attributes("data-testid"))).toEqual([
      "skeleton-row",
      "skeleton-row",
      "skeleton-row",
    ]);

    first.resolve(Response.json(CERTIFICATES));
    await flushPromises();
    expect(rows(wrapper, "certificate-table")).toHaveLength(3);

    void queryClient.invalidateQueries({ queryKey: ["certificates"] });
    await flushPromises();
    expect(requests).toBe(2);
    expect(wrapper.find('[data-testid="skeleton-row"]').exists()).toBe(false);
    expect(rows(wrapper, "certificate-table")).toHaveLength(3);

    again.resolve(Response.json(CERTIFICATES.slice(0, 1)));
    await flushPromises();
    expect(rows(wrapper, "certificate-table")).toHaveLength(1);
  });

  it("reports a failed list with its error text and retries on request", async () => {
    let fail = true;
    const { wrapper, api } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/crls": () => (fail ? envelope(500, "internal") : Response.json(targetItems())),
    });

    // A 5xx is retried once (the app's QueryClient) before the page reports it.
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(true);
    });
    expect(api.calls().filter((call) => call === "GET /api/v1/crls")).toHaveLength(2);
    const alert = wrapper.get('[data-testid="query-error"]');
    expect(alert.text()).toContain("Could not load the CRL targets");
    expect(alert.text()).toContain("The server failed. Try again later.");
    // Without the list, the attention count is not known yet.
    expect(stat(wrapper, "attention")).toBe("—");

    fail = false;
    await alert.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(false);
    expect(rows(wrapper, "crl-target-table")).toHaveLength(3);
  });

  it("speaks zh-CN", async () => {
    const { wrapper } = await open("/", OVERVIEW, "zh-CN");

    expect(document.title).toBe("总览 · Test PKI");
    expect(wrapper.get('[data-stat="attention"] dt').text()).toBe("需关注");
    expect(rows(wrapper, "crl-target-table")[1]!.get("[data-kind]").text()).toBe("增量 CRL");
    expect(rows(wrapper, "certificate-table").map((row) => row.get("a").text())).toContain(
      "未知证书"
    );
  });
});

describe("CertificatePage", () => {
  const path = `/certificates/${ROOT.id}`;
  const routes = {
    [`GET /api/v1/certificates/${ROOT.id}`]: () => Response.json(ROOT),
    "GET /ca/root-ca.crt.pem": () =>
      new Response("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"),
  };

  it("shows the header and the overview with algorithms, (r, s), fingerprints and targets", async () => {
    const { wrapper, api } = await open(path, routes);

    expect(api.calls()).toEqual([`GET /api/v1/certificates/${ROOT.id}`]);
    expect(wrapper.get("h1").text()).toBe("Root CA");
    expect(document.title).toBe("Root CA · Test PKI");
    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("certificate");
    expect(wrapper.find('section [data-state="valid"]').exists()).toBe(true);

    const text = wrapper.text();
    expect(text).toContain("CN=Example Root CA (ECC P-384),O=Example PKI,C=US");
    // §10 #28: the algorithms with their parameters, never "Unknown".
    expect(wrapper.get('[data-testid="signature"]').text()).toContain("ecdsa-with-SHA384");
    expect(wrapper.get('[data-testid="public-key"]').text()).toContain("ecPublicKey (P-384)");
    expect(wrapper.get('[data-testid="public-key"]').text()).toContain("P-384");
    expect(wrapper.get('[data-testid="signature"]').text()).toContain("Signature r");
    expect(wrapper.get('[data-testid="signature"]').text()).toContain("7A:7A:7A");
    expect(text).toContain(ROOT.id.slice(0, 2).toUpperCase());
    expect(text).not.toContain("Unknown");
    // The validity detail: time to notAfter.
    expect(wrapper.get('[data-testid="validity-detail"]').text()).toBe("(in 6937d)");
    // §10 #10: the targets this certificate issues.
    const target = wrapper.get('[data-testid="crl-targets"] a');
    expect(target.text()).toBe("Root CA");
    expect(target.attributes("href")).toBe(`/crls/${TARGET_IDS.rootFull}`);
  });

  it("lists the extensions and fetches the PEM text only for its tab", async () => {
    const { wrapper, api } = await open(path, routes);

    await selectTab(wrapper, /Extensions/);
    expect(wrapper.get('[data-oid="2.5.29.19"]').text()).toContain("basicConstraints");

    expect(api.calls()).not.toContain("GET /ca/root-ca.crt.pem");
    await selectTab(wrapper, /PEM/);
    expect(api.calls()).toContain("GET /ca/root-ca.crt.pem");
    expect(wrapper.get('[data-testid="pem-text"]').text()).toContain("BEGIN CERTIFICATE");
  });

  it("lists the CRL targets it issues in the overview's order: by label, full before delta", async () => {
    const id = (last: string) => `4f0d3c1a-6a8e-4b8f-9c55-1d2e3f40${last}`;
    const { wrapper } = await open(path, {
      [`GET /api/v1/certificates/${ROOT.id}`]: () =>
        Response.json({
          ...ROOT,
          targets: [
            { targetId: id("5161"), kind: "delta", label: "Root CA" },
            { targetId: id("5164"), kind: "full", label: "Root CA" },
            { targetId: id("5169"), kind: "full", label: "Archive" },
          ],
        }),
    });

    const links = wrapper.findAll('[data-testid="crl-targets"] li');
    expect(
      links.map((link) => [link.get("[data-kind]").attributes("data-kind"), link.text()])
    ).toEqual([
      ["full", "Full CRLArchive"],
      ["full", "Full CRLRoot CA"],
      ["delta", "Delta CRLRoot CA"],
    ]);
  });

  it("keeps the heading levels in order and the tab panels' focus ring visible", async () => {
    const { wrapper } = await open(path, routes);

    expectHeadingOutline(wrapper);
    expectFocusRing(wrapper.get('[role="tabpanel"]'));
    // Wide content (PEM, ASN.1 dumps) scrolls inside its box instead of widening the page.
    expect(wrapper.get('[data-slot="tabs"]').classes()).toContain("min-w-0");
    expect(wrapper.get('[data-slot="tabs-list"]').classes()).toEqual(
      expect.arrayContaining(["max-w-full", "overflow-x-auto", "justify-start"])
    );
    await selectTab(wrapper, /Extensions/);
    expectHeadingOutline(wrapper);
    expectFocusRing(wrapper.get('[role="tabpanel"]'));
    await selectTab(wrapper, /PEM/);
    expectFocusRing(wrapper.get('[role="tabpanel"]'));
  });

  it("has no PEM tab without a .pem download", async () => {
    const { wrapper } = await open(path, {
      [`GET /api/v1/certificates/${ROOT.id}`]: () =>
        Response.json({ ...ROOT, downloads: ["/ca/root-ca.crt"] }),
    });

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "Overview",
      "Extensions (1)",
    ]);
  });

  it("says that an unknown id does not exist (404, not retried)", async () => {
    const { wrapper, api } = await open(path, {});

    // A retry would show the state only after a timer turn, and send a second request.
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="missing"]').exists()).toBe(true);
    });
    expect(wrapper.get('[data-testid="missing"]').text()).toContain("Certificate not found");
    expect(document.title).toBe("Certificate not found · Test PKI");
    expect(api.calls()).toEqual([`GET /api/v1/certificates/${ROOT.id}`]);
  });

  it("never requests a malformed id", async () => {
    const { wrapper, api } = await open("/certificates/not-an-id", {});

    expect(wrapper.find('[data-testid="not-found-page"]').exists()).toBe(true);
    expect(api.calls()).toEqual([]);
  });
});

describe("CrlTargetPage", () => {
  const path = `/crls/${TARGET_IDS.issuingFull}`;
  const detailRoute = `GET /api/v1/crls/${TARGET_IDS.issuingFull}`;

  it("shows the current CRL with its numbers, times and signature algorithm parameters", async () => {
    const { wrapper } = await open(path, {
      [detailRoute]: () => Response.json(issuingFullDetail()),
    });

    expect(wrapper.get("h1").text()).toBe("Issuing CA 01");
    expect(document.title).toBe("Issuing CA 01 · Test PKI");
    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("full");
    const issuer = wrapper.get('[data-testid="issuer-link"]');
    expect(issuer.text()).toBe("Example Issuing CA 01 (RSA)");
    expect(issuer.attributes("href")).toBe(`/certificates/${certificateItem("issuing-ca-1").id}`);

    const overview = wrapper.get('[data-testid="crl-overview"]').text();
    expect(overview).toContain("CRL Number16");
    expect(overview).toContain(`RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)`);
    expect(RSASSA_PSS.parameters?.parsed?.type).toBe("rsassaPss");
    expect(overview).not.toContain("Base CRL Number");

    await selectTab(wrapper, /Revoked/);
    expect(wrapper.findAll('[data-testid="revoked-table"] tbody tr')).toHaveLength(2);
    await selectTab(wrapper, /Extensions/);
    expect(wrapper.find('[data-oid="2.5.29.20"]').exists()).toBe(true);
  });

  it("shows a delta CRL's numbers, its three times and its Next CRL Publish", async () => {
    vi.stubEnv("TZ", "UTC");
    const delta = issuingDeltaDetail();
    const { wrapper } = await open(`/crls/${TARGET_IDS.issuingDelta}`, {
      [`GET /api/v1/crls/${TARGET_IDS.issuingDelta}`]: () => Response.json(delta),
    });

    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("delta");
    expect(wrapper.find('header [data-state="current"]').exists()).toBe(true);
    // crls/issuing-ca-1/delta-adcs: 20 on base 19, Next CRL Publish 2026-01-04T18:00:00Z.
    expect(definitions(wrapper.get('[data-testid="crl-overview"]'))).toEqual(
      expect.arrayContaining([
        ["CRL Number", "20"],
        ["Base CRL Number", "19"],
        ["This Update", "Jan 03, 2026 17:50:00 (UTC)"],
        ["Next Update", "Jan 05, 2026 06:10:00 (UTC)"],
        ["Next CRL Publish", "Jan 04, 2026 18:00:00 (UTC)"],
      ])
    );
    expect(wrapper.get('[data-testid="status-detail"]').text()).toBe("(in 1d 6h 10m)");
  });

  it("measures a CRL that is not yet valid to its thisUpdate", async () => {
    // Two minutes before full-pss's thisUpdate (2026-01-03T12:00:00Z): a browser clock behind the
    // server's, or the 5 minutes of skew the server accepts.
    vi.setSystemTime(new Date("2026-01-03T11:58:00Z"));
    const { wrapper } = await open(path, {
      [detailRoute]: () => Response.json(issuingFullDetail()),
    });

    expect(wrapper.find('header [data-state="not-yet-valid"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="status-detail"]').text()).toBe("(in 2m)");
  });

  it("keeps the heading levels in order, the panels' focus ring and no vue-i18n warning", async () => {
    const warn = vi.spyOn(console, "warn");
    const { wrapper } = await open(path, {
      [detailRoute]: () => Response.json(issuingFullDetail()),
    });

    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/intlify/);
    expectHeadingOutline(wrapper);
    expectFocusRing(wrapper.get('[role="tabpanel"]'));
    expect(wrapper.get('[data-slot="tabs"]').classes()).toContain("min-w-0");
    expect(wrapper.get('[data-slot="tabs-list"]').classes()).toEqual(
      expect.arrayContaining(["max-w-full", "overflow-x-auto", "justify-start"])
    );
    for (const tab of [/Revoked/, /Extensions/]) {
      await selectTab(wrapper, tab);
      expectHeadingOutline(wrapper);
      expectFocusRing(wrapper.get('[role="tabpanel"]'));
    }
  });

  it("shows an unpublished target as not published, without a revoked list", async () => {
    const { wrapper } = await open(path, {
      [detailRoute]: () => Response.json(issuingFullDetail({ published: false })),
    });

    expect(wrapper.get("h1").text()).toBe("Issuing CA 01");
    // The issuer link is in the header, so it stays without a CRL.
    expect(wrapper.get('[data-testid="issuer-link"]').attributes("href")).toBe(
      `/certificates/${certificateItem("issuing-ca-1").id}`
    );
    expect(wrapper.get('[data-testid="unpublished"]').text()).toContain("Not published");
    expect(wrapper.find('header [data-state="unpublished"]').exists()).toBe(true);
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="revoked-table"]').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/\(0\)/);
    // Its download paths answer 404 until a CRL is published.
    expect(wrapper.find("main header a[download]").exists()).toBe(false);
    expect(wrapper.get("main header").text()).toContain("—");
  });

  it("says that an unknown target does not exist", async () => {
    const { wrapper } = await open(path, {});

    expect(wrapper.get('[data-testid="missing"]').text()).toContain("CRL target not found");
    expect(document.title).toBe("CRL target not found · Test PKI");
  });

  it("shows other failures with their error text", async () => {
    const { wrapper } = await open(path, { [detailRoute]: () => envelope(400, "bad_request") });

    expect(wrapper.find('[data-testid="missing"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="query-error"]').text()).toContain(
      "The request was malformed."
    );
  });
});
