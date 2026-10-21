// Shared display and X.509 components (implementation slice 5b steps 3 and 4), mounted in
// happy-dom. Rewrite of worker-aia-cdp@5b570aa:tests/web/components.test.ts (SSR render through a
// Vite server there): its ResourceCard case becomes the DownloadLinks case, and its CRL details
// case moves to revoked-table.test.ts with the revoked table.
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import type { Component } from "vue";
import { toast } from "vue-sonner";
import type { DistributionPoint, Extension, GeneralName, Name } from "@/client/types";
import DownloadLinks from "@/components/DownloadLinks.vue";
import HexValue from "@/components/HexValue.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import LocaleSelect from "@/components/LocaleSelect.vue";
import PemText from "@/components/PemText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Accordion } from "@/components/ui/accordion";
import Asn1Dump from "@/components/x509/Asn1Dump.vue";
import DistributionPointList from "@/components/x509/DistributionPointList.vue";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import ExtensionView from "@/components/x509/ExtensionView.vue";
import GeneralNameList from "@/components/x509/GeneralNameList.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  // happy-dom has no execCommand; the copy tests install one for the textarea fallback.
  Reflect.deleteProperty(document, "execCommand");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(component: Component, props: Record<string, unknown>, locale: AppLocale = "en") {
  wrapper = mount(component, { props, global: { plugins: [createAppI18n(locale)] } });
  return wrapper;
}

describe("DownloadLinks", () => {
  it("labels DER paths and .pem paths, keeping nested paths as the server sent them", () => {
    const links = render(DownloadLinks, {
      downloads: ["/ca/nested/root.crt", "/ca/nested/root.crt.pem"],
    }).findAll("a");
    expect(links.map((link) => [link.attributes("href"), link.attributes("data-format")])).toEqual([
      ["/ca/nested/root.crt", "DER"],
      ["/ca/nested/root.crt.pem", "PEM"],
    ]);
    expect(links.every((link) => link.attributes("download") !== undefined)).toBe(true);
    expect(links[1]!.text()).toBe("PEM: /ca/nested/root.crt.pem");
  });

  it("names the files when a resource is served at more than one DER path", () => {
    const links = render(DownloadLinks, {
      downloads: ["/ca/root.crt", "/ca/root.crt.pem", "/ca/legacy/root-2016.cer"],
    }).findAll("a");
    expect(links.map((link) => link.get('[data-testid="file-name"]').text())).toEqual([
      "root.crt",
      "root.crt.pem",
      "root-2016.cer",
    ]);
    expect(links[2]!.attributes("data-format")).toBe("DER");
  });

  it("is an outlined button in both themes (the variant's border wins over the base's)", () => {
    const link = render(DownloadLinks, { downloads: ["/ca/root.crt"] }).get("a");
    expect(link.classes()).toContain("border-border");
    expect(link.classes()).not.toContain("border-transparent");
  });

  it("never derives a second .pem from a .pem path", () => {
    const html = render(DownloadLinks, { downloads: ["/crl/root.crl.pem"] }).html();
    expect(html).not.toMatch(/\.pem\.pem|data-format="DER"/);
  });

  it("shows a dash without downloads", () => {
    const links = render(DownloadLinks, { downloads: [] });
    expect(links.find("a").exists()).toBe(false);
    expect(links.text()).toBe("—");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["valid", "Valid"],
    ["expiring", "Expiring"],
    ["not-yet-valid", "Not Yet Valid"],
    ["current", "Current"],
    ["stale", "Stale"],
    ["expired", "Expired"],
    ["unknown", "Unknown"],
    ["unpublished", "Not published"],
  ])("labels %s", (state, label) => {
    const badge = render(StatusBadge, { state });
    expect(badge.text()).toBe(label);
    expect(badge.attributes("data-state")).toBe(state);
  });

  it("colours states with theme tokens and speaks zh-CN", () => {
    expect(render(StatusBadge, { state: "expired" }).classes()).toContain("text-destructive");
    expect(render(StatusBadge, { state: "stale" }).classes()).toContain("text-warning");
    expect(render(StatusBadge, { state: "current" }).classes()).toContain("text-success");
    expect(render(StatusBadge, { state: "unpublished" }, "zh-CN").text()).toBe("未发布");
    expect(render(StatusBadge, { state: "expiring" }, "zh-CN").text()).toBe("即将过期");
  });
});

describe("KeyValueList", () => {
  it("shows labels with values, hex grouped, and (empty) for a missing value", () => {
    const list = render(KeyValueList, {
      items: [
        { label: "SHA-1", value: "0a1b2c", hex: true },
        { label: "Comment", value: "  two\nlines" },
        { label: "Nothing", value: "" },
        { label: "Unset", value: null, title: "utf8String" },
      ],
    });
    const terms = list.findAll("dt");
    const values = list.findAll("dd");
    expect(terms.map((term) => term.text())).toEqual(["SHA-1", "Comment", "Nothing", "Unset"]);
    expect(values[0]!.get('[data-testid="hex-value"]').text()).toBe("0A:1B:2C");
    expect(values[1]!.text()).toBe("two\nlines");
    expect(values[2]!.text()).toBe("(empty)");
    expect(values[3]!.text()).toBe("(empty)");
    expect(terms[3]!.attributes("title")).toBe("utf8String");
  });
});

describe("HexValue", () => {
  it("groups bytes without spaces and copies the bare digits with the Clipboard API", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    const hex = render(HexValue, { value: "0a:1b 2c", variant: "grouped" });
    expect(hex.get('[data-testid="hex-value"]').element.textContent).toBe("0A:1B:2C");
    expect(hex.findAll("wbr")).toHaveLength(3);
    const button = hex.get("button");
    expect(button.attributes("aria-label")).toBe("Copy");
    await button.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("0A1B2C");
    expect(execCommand).not.toHaveBeenCalled();
    expect(button.attributes("aria-label")).toBe("Copied");
  });

  it("falls back to a selected textarea where the Clipboard API refuses, keeping the focus", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
    const copied: string[] = [];
    document.execCommand = vi.fn((command: string) => {
      copied.push(`${command}:${document.querySelector("textarea")?.value ?? ""}`);
      return true;
    });

    wrapper = mount(HexValue, {
      props: { value: "0a1b" },
      attachTo: document.body,
      global: { plugins: [createAppI18n("en")] },
    });
    const button = wrapper.get("button");
    (button.element as HTMLButtonElement).focus();
    await button.trigger("click");
    await flushPromises();
    expect(copied).toEqual(["copy:0A1B"]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button.element);
    expect(button.attributes("aria-label")).toBe("Copied");
  });

  it("reports a copy that execCommand refuses as a toast, not as copied", async () => {
    // Plain HTTP: no Clipboard API; the browser answers execCommand("copy") with false.
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const execCommand = vi.fn(() => false);
    document.execCommand = execCommand;
    const error = vi.spyOn(toast, "error");

    const hex = render(HexValue, { value: "0A1B" }, "zh-CN");
    const button = hex.get("button");
    await button.trigger("click");
    await flushPromises();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(error).toHaveBeenCalledWith("无法复制到剪贴板");
    expect(button.attributes("aria-label")).toBe("复制");
  });

  it("reports a failed copy as a toast without any copy mechanism", async () => {
    // No Clipboard API and no document.execCommand (as in happy-dom).
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const error = vi.spyOn(toast, "error");

    const hex = render(HexValue, { value: "0A1B" }, "zh-CN");
    expect(hex.get('[data-testid="hex-value"]').text()).toBe("0A1B");
    await hex.get("button").trigger("click");
    await flushPromises();
    expect(error).toHaveBeenCalledWith("无法复制到剪贴板");
  });

  it("shows the fallback and no copy button without a value", () => {
    const hex = render(HexValue, { value: null, fallback: "—" });
    expect(hex.text()).toBe("—");
    expect(hex.find("button").exists()).toBe(false);
  });
});

describe("PemText", () => {
  it("reports a copy that execCommand refuses as a toast", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("-----BEGIN CERTIFICATE-----\n")))
    );
    document.execCommand = vi.fn(() => false);
    const error = vi.spyOn(toast, "error");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    wrapper = mount(PemText, {
      props: { path: "/ca/root-ca.crt.pem" },
      global: { plugins: [createAppI18n("en"), [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="pem-text"]').text()).toContain("BEGIN CERTIFICATE");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(error).toHaveBeenCalledWith("Could not copy to the clipboard");
    expect(wrapper.get("button").text()).toBe("Copy");
    queryClient.clear();
  });
});

describe("LocaleSelect", () => {
  it("switches the global locale between the two UI languages", async () => {
    const select = render(LocaleSelect, {}).get("select");
    expect(
      wrapper!.findAll("option").map((option) => [option.attributes("value"), option.text()])
    ).toEqual([
      ["en", "English"],
      ["zh-CN", "简体中文"],
    ]);
    expect(wrapper!.text()).toContain("Language");
    await select.setValue("zh-CN");
    // The global scope: the label (and the rest of the app) switches language.
    expect(wrapper!.text()).toContain("语言");
    expect((select.element as HTMLSelectElement).value).toBe("zh-CN");
  });
});

describe("NameDetails", () => {
  const name = {
    commonName: " <script>bad</script> ",
    organization: " ",
    organizationalUnit: null,
    country: "US",
    stateOrProvince: null,
    locality: null,
    rdnSequence: [
      {
        attributes: [
          {
            type: { oid: "0.9.2342.19200300.100.1.25", name: "DC" },
            value: { string: "test", encoding: "ia5String" },
          },
        ],
      },
      {
        attributes: [
          {
            type: { oid: "1.2.3.4", name: null },
            value: { string: null, encoding: "unknown", rawHex: "0101ff" },
          },
        ],
      },
    ],
    rfc4514: "CN=<script>bad</script>,C=US,1.2.3.4=#0101ff,DC=test",
  } satisfies Name;

  it("escapes text and keeps the labels of empty fields", () => {
    const details = render(NameDetails, { title: "Issuer", name });
    const html = details.html();
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>bad");
    expect(details.get("h2").text()).toBe("Issuer");
    const pairs = details
      .findAll("dt")
      .map((term, index) => [term.text(), details.findAll("dd")[index]!.text()]);
    expect(pairs).toEqual([
      ["Common Name", "<script>bad</script>"],
      ["Organization", "(empty)"],
      ["Organizational Unit", "(empty)"],
      ["Country Name", "US"],
      ["State/Province", "(empty)"],
      ["Locality", "(empty)"],
      ["DC", "test"],
      ["1.2.3.4", "#0101ff"],
    ]);
    expect(details.findAll("dt")[6]!.attributes("title")).toBe("ia5String");
  });

  it("labels the fields in zh-CN", () => {
    const details = render(NameDetails, { name }, "zh-CN");
    expect(details.find("h2").exists()).toBe(false);
    expect(details.findAll("dt")[0]!.text()).toBe("通用名称");
    expect(details.findAll("dd")[1]!.text()).toBe("（空）");
  });
});

function extension(oid: string, name: string | null, critical: boolean): Extension {
  return {
    extnID: { oid, name },
    critical,
    extnValue: { hex: "0c0141", byteLength: 3 },
    parseStatus: "unsupported",
    asn1: [{ depth: 0, tag: "UTF8String", length: 1, value: "A" }],
  } satisfies Extension;
}

describe("ExtensionList", () => {
  it("puts critical extensions first, then sorts by name, without reordering its input", () => {
    const items = [
      extension("1.2.3", "AAA optional", false),
      extension("1.2.4", "ZZZ critical", true),
      extension("1.2.5", null, false),
      extension("1.2.6", "BBB critical", true),
    ];
    const list = render(ExtensionList, { extensions: items });
    expect(list.findAll("[data-oid]").map((item) => item.attributes("data-oid"))).toEqual([
      "1.2.6",
      "1.2.4",
      "1.2.5",
      "1.2.3",
    ]);
    expect(items.map((item) => item.extnID.oid)).toEqual(["1.2.3", "1.2.4", "1.2.5", "1.2.6"]);
    expect(list.findAll('[data-testid="critical"]')).toHaveLength(2);
  });

  it("renders nothing without extensions", () => {
    expect(render(ExtensionList, { extensions: [] }).find("[data-oid]").exists()).toBe(false);
  });
});

describe("GeneralNameList", () => {
  it("prefixes each name with its type label, otherName with its own name", () => {
    const names: GeneralName[] = [
      { type: "dNSName", value: "leaf.example.test" },
      { type: "iPAddress", value: "2001:db8::10" },
      {
        type: "otherName",
        value: "leaf@example.test",
        typeOid: "1.3.6.1.4.1.311.20.2.3",
        typeName: "userPrincipalName",
      },
      { type: "x400Address", value: "", rawHex: "a003" },
    ];
    expect(
      render(GeneralNameList, { names })
        .findAll("li")
        .map((item) => item.text())
    ).toEqual([
      "DNS: leaf.example.test",
      "IP: 2001:db8::10",
      "userPrincipalName: leaf@example.test",
      "X.400: a003",
    ]);
    expect(render(GeneralNameList, { names: names.slice(0, 1) }, "zh-CN").text()).toBe(
      "DNS: leaf.example.test"
    );
  });
});

describe("DistributionPointList", () => {
  it("shows names, reasons as tags and the CRL issuer", () => {
    const points = [
      {
        distributionPoint: {
          fullName: [
            {
              type: "uniformResourceIdentifier",
              value: "http://pki.example.test/crl/issuing-ca-1.crl",
            },
          ],
        },
        reasons: ["keyCompromise", "cACompromise"],
        cRLIssuer: [
          { type: "directoryName", value: "CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US" },
        ],
      },
      {
        distributionPoint: {
          nameRelativeToCRLIssuer: {
            attributes: [
              {
                type: { oid: "2.5.4.3", name: "CN" },
                value: { string: "CRL1", encoding: "utf8String" },
              },
            ],
          },
        },
      },
    ] satisfies DistributionPoint[];
    const list = render(DistributionPointList, { points });
    const [first, second] = list.findAll(":scope > li");
    expect(first!.text()).toContain("URI: http://pki.example.test/crl/issuing-ca-1.crl");
    expect(
      first!.findAll("[data-tone]").map((tag) => [tag.text(), tag.attributes("data-tone")])
    ).toEqual([
      ["keyCompromise", "amber"],
      ["cACompromise", "amber"],
    ]);
    expect(first!.text()).toContain("Reasons:");
    expect(first!.text()).toContain("CRL issuer:");
    expect(first!.text()).toContain("DirName: CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US");
    expect(second!.text()).toBe("Relative to CRL issuer: CN=CRL1");
    expect(second!.find("[data-tone]").exists()).toBe(false);
  });
});

describe("Asn1Dump", () => {
  it("indents two spaces per depth and shows tag, length and value", () => {
    const dump = render(Asn1Dump, {
      lines: [
        { depth: 0, tag: "SEQUENCE", length: 9 },
        { depth: 1, tag: "INTEGER", length: 1, value: "5" },
        { depth: 2, tag: "UTF8String", length: 2, value: "hi" },
      ],
    });
    const lines = dump.findAll("li");
    expect(lines.map((line) => line.element.textContent)).toEqual([
      "SEQUENCE (9)",
      "  INTEGER (1) 5",
      "    UTF8String (2) hi",
    ]);
    expect(lines[2]!.get('[data-testid="asn1-indent"]').element.textContent).toBe("    ");
  });
});

describe("ExtensionView", () => {
  /** An ExtensionView inside an Accordion, opened. */
  function renderOpen(value: Extension, locale: AppLocale = "en") {
    wrapper = mount(Accordion, {
      props: { type: "multiple", defaultValue: [value.extnID.oid] },
      slots: { default: () => h(ExtensionView, { extension: value, value: value.extnID.oid }) },
      global: { plugins: [createAppI18n(locale)] },
    });
    return wrapper;
  }

  it("lists access descriptions as method: location", () => {
    // ext_leaf_full: caIssuers and OCSP.
    const aia = {
      extnID: { oid: "1.3.6.1.5.5.7.1.1", name: "Authority Information Access" },
      critical: false,
      extnValue: { hex: "3000", byteLength: 2 },
      parseStatus: "parsed",
      parsed: {
        extensionType: "authorityInfoAccess",
        accessDescriptions: [
          {
            accessMethod: { oid: "1.3.6.1.5.5.7.48.2", name: "caIssuers" },
            accessLocation: {
              type: "uniformResourceIdentifier",
              value: "http://pki.example.test/ca/issuing-ca-1.crt",
            },
          },
          {
            accessMethod: { oid: "1.3.6.1.5.5.7.48.1", name: "ocsp" },
            accessLocation: {
              type: "uniformResourceIdentifier",
              value: "http://ocsp.example.test/",
            },
          },
        ],
      },
    } satisfies Extension;
    expect(
      renderOpen(aia)
        .findAll("li")
        .map((item) => item.text())
    ).toEqual([
      "caIssuers: URI: http://pki.example.test/ca/issuing-ca-1.crt",
      "ocsp: URI: http://ocsp.example.test/",
    ]);
  });

  it("shows the parse error, the ASN.1 dump and the raw hex of an undecoded extension", async () => {
    // crls/issuing-ca-1 fixture with crl_ext_unknown_critical (UTF8String in an unknown OID).
    const unknown = {
      extnID: { oid: "1.3.6.1.4.1.32473.1", name: null },
      critical: true,
      extnValue: { hex: "0c03616263", byteLength: 5 },
      parseStatus: "error",
      parseError: "Unexpected value",
      asn1: [
        { depth: 0, tag: "SEQUENCE", length: 5 },
        { depth: 1, tag: "UTF8String", length: 3, value: "abc" },
      ],
    } satisfies Extension;
    const view = renderOpen(unknown);
    expect(view.get("button").text()).toContain("1.3.6.1.4.1.32473.1");
    expect(view.get('[data-testid="critical"]').text()).toBe("Critical");
    expect(view.get('[data-testid="parse-status"]').text()).toBe("Decode error");
    expect(view.get('[data-testid="parse-error"]').text()).toBe("Error: Unexpected value");
    expect(view.findAll("ol > li").map((line) => line.element.textContent)).toEqual([
      "SEQUENCE (5)",
      "  UTF8String (3) abc",
    ]);
    // The raw value is collapsed until asked for.
    expect(view.find('[data-testid="hex-value"]').exists()).toBe(false);
    const rawHex = view.findAll("button").find((button) => button.text() === "Raw value (hex)");
    expect(rawHex).toBeDefined();
    await rawHex!.trigger("click");
    expect(view.get('[data-testid="hex-value"]').element.textContent).toBe("0C:03:61:62:63");
  });

  it("renders the blocks of a decoded extension without dump or raw value", () => {
    // ext_issuing: Microsoft CA Version V0.0.
    const caVersion = {
      extnID: { oid: "1.3.6.1.4.1.311.21.1", name: "CA Version" },
      critical: false,
      extnValue: { hex: "020100", byteLength: 3 },
      parseStatus: "parsed",
      parsed: { extensionType: "msCaVersion", certificateIndex: 0, keyIndex: 0 },
    } satisfies Extension;
    const view = renderOpen(caVersion, "zh-CN");
    const header = view.get("button").text();
    expect(header).toContain("CA Version");
    expect(header).toContain("1.3.6.1.4.1.311.21.1");
    expect(view.find('[data-testid="parse-status"]').exists()).toBe(false);
    expect(view.find('[data-testid="critical"]').exists()).toBe(false);
    expect(view.findAll("dt").map((term) => term.text())).toEqual(["CA 证书索引", "CA 密钥索引"]);
    expect(view.findAll("dd").map((value) => value.text())).toEqual(["0", "0"]);
    expect(view.find("ol").exists()).toBe(false);
  });

  it("falls back to the raw view for an extension type this build does not know", () => {
    const future = {
      extnID: { oid: "1.3.6.1.4.1.32473.3", name: "Future" },
      critical: false,
      extnValue: { hex: "0500", byteLength: 2 },
      parseStatus: "parsed",
      parsed: { extensionType: "brandNew" },
    } as unknown as Extension;
    const view = renderOpen(future);
    expect(view.get('[data-testid="parse-status"]').text()).toBe("Not decoded");
    expect(view.findAll("button").some((button) => button.text() === "Raw value (hex)")).toBe(true);
  });
});
