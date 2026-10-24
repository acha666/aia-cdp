// Shared display and X.509 components, mounted in happy-dom.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import type { Component } from "vue";
import { toast } from "vue-sonner";
import { definitions } from "./helpers";
import type { Extension, Name } from "@/client/types";
import DownloadLinks from "@/components/DownloadLinks.vue";
import HexValue from "@/components/HexValue.vue";
import LocaleSelect from "@/components/LocaleSelect.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Accordion } from "@/components/ui/accordion";
import ValueView from "@/components/ValueView.vue";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import ExtensionView from "@/components/x509/ExtensionView.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

// happy-dom has no execCommand; the copy tests install one for the textarea fallback.
afterEach(() => Reflect.deleteProperty(document, "execCommand"));

function render(component: Component, props: Record<string, unknown>, locale: AppLocale = "en") {
  return mount(component, { props, global: { plugins: [createAppI18n(locale)] } });
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
});

describe("HexValue", () => {
  it("groups bytes without spaces and copies the bare digits with the Clipboard API", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    const hex = render(HexValue, { value: "0a1b2c" });
    expect(hex.get('[data-testid="hex-value"]').element.textContent).toBe("0A:1B:2C");
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
      // The browser copies the selection: the textarea that has the focus.
      const area = document.activeElement;
      copied.push(`${command}:${area instanceof HTMLTextAreaElement ? area.value : ""}`);
      return true;
    });

    const hex = mount(HexValue, {
      props: { value: "0a1b" },
      attachTo: document.body,
      global: { plugins: [createAppI18n("en")] },
    });
    const button = hex.get("button");
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
});

describe("ValueView", () => {
  it.each([null, "", { hex: "" }, { lines: [] }, { tags: [] }])("reads (empty) for %j", (value) => {
    expect(render(ValueView, { value }).text()).toBe("(empty)");
  });

  it("gives each line or tag a list item", () => {
    const lines = render(ValueView, { value: { lines: ["URI: http://a.test/", "DNS: b.test"] } });
    expect(lines.findAll("li").map((item) => item.text())).toEqual([
      "URI: http://a.test/",
      "DNS: b.test",
    ]);
    expect(render(ValueView, { value: { tags: ["a", "b"] } }).findAll("li")).toHaveLength(2);
  });
});

describe("LocaleSelect", () => {
  it("switches the global locale between the two UI languages", async () => {
    const locale = render(LocaleSelect, {});
    const select = locale.get("select");
    expect(
      locale.findAll("option").map((option) => [option.attributes("value"), option.text()])
    ).toEqual([
      ["en", "English"],
      ["zh-CN", "简体中文"],
    ]);
    expect(locale.text()).toContain("Language");
    await select.setValue("zh-CN");
    // The global scope: the label (and the rest of the app) switches language.
    expect(locale.text()).toContain("语言");
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

  it("keeps the labels of empty fields", () => {
    const details = render(NameDetails, { title: "Issuer", name });
    expect(definitions(details)).toEqual([
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
});

describe("ExtensionView", () => {
  /** An ExtensionView inside an Accordion, opened. */
  function renderOpen(value: Extension, locale: AppLocale = "en") {
    return mount(Accordion, {
      props: { type: "multiple", defaultValue: [value.extnID.oid] },
      slots: { default: () => h(ExtensionView, { extension: value, value: value.extnID.oid }) },
      global: { plugins: [createAppI18n(locale)] },
    });
  }

  it("shows the parse error, the ASN.1 dump and the raw hex of an undecoded extension", async () => {
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

  it("renders the sections of a decoded extension without dump or raw value", () => {
    // A CA renewed with its old key: CA Version V1.0.
    const caVersion = {
      extnID: { oid: "1.3.6.1.4.1.311.21.1", name: "CA Version" },
      critical: false,
      extnValue: { hex: "02020100", byteLength: 4 },
      parseStatus: "parsed",
      parsed: { extensionType: "msCaVersion", certificateIndex: 1, keyIndex: 0 },
    } satisfies Extension;
    const view = renderOpen(caVersion, "zh-CN");
    const header = view.get("button").text();
    expect(header).toContain("CA Version");
    expect(header).toContain("1.3.6.1.4.1.311.21.1");
    expect(view.find('[data-testid="parse-status"]').exists()).toBe(false);
    expect(view.find('[data-testid="critical"]').exists()).toBe(false);
    expect(definitions(view)).toEqual([
      ["CA 证书索引", "1"],
      ["CA 密钥索引", "0"],
    ]);
  });

  /** A decoded extension of `parsed`'s type (the header and value are not looked at here). */
  function decoded(oid: string, parsed: NonNullable<Extension["parsed"]>): Extension {
    return {
      extnID: { oid, name: parsed.extensionType },
      critical: false,
      extnValue: { hex: "3000", byteLength: 2 },
      parseStatus: "parsed",
      parsed,
    };
  }

  it("draws one list per section, a hex value with HexValue, and (empty) without sections", () => {
    const uri = (value: string) => ({ type: "uniformResourceIdentifier" as const, value });
    const freshest = renderOpen(
      decoded("2.5.29.46", {
        extensionType: "freshestCRL",
        distributionPoints: [
          { distributionPoint: { fullName: [uri("http://a.test/a.crl")] } },
          {
            distributionPoint: { fullName: [uri("http://b.test/b.crl")] },
            reasons: ["keyCompromise"],
          },
        ],
      })
    );
    expect(freshest.findAll("dl")).toHaveLength(2);

    const ski = renderOpen(
      decoded("2.5.29.14", { extensionType: "subjectKeyIdentifier", keyIdentifier: "AB12" })
    );
    expect(ski.get('dd [data-testid="hex-value"]').element.textContent).toBe("AB:12");
    // No sections: the body reads "(empty)".
    expect(renderOpen(decoded("2.5.29.30", { extensionType: "nameConstraints" })).text()).toContain(
      "(empty)"
    );
  });

  it("names the access methods in the UI language, else as the server sent them", () => {
    const uri = (value: string) => ({ type: "uniformResourceIdentifier" as const, value });
    const view = renderOpen(
      decoded("1.3.6.1.5.5.7.1.1", {
        extensionType: "authorityInfoAccess",
        accessDescriptions: [
          {
            accessMethod: { oid: "1.3.6.1.5.5.7.48.2", name: "caIssuers" },
            accessLocation: uri("http://a.test/ca.crt"),
          },
          {
            accessMethod: { oid: "1.3.6.1.5.5.7.48.4", name: null },
            accessLocation: uri("http://a.test/dvcs"),
          },
          {
            accessMethod: { oid: "1.3.6.1.4.1.32473.5", name: "exampleMethod" },
            accessLocation: uri("http://a.test/x"),
          },
        ],
      }),
      "zh-CN"
    );
    expect(view.findAll("dt").map((term) => term.text())).toEqual([
      "CA 签发者",
      "1.3.6.1.5.5.7.48.4",
      "exampleMethod",
    ]);
  });

  it("marks an extension the server does not decode as such, with its raw value", () => {
    const view = renderOpen(extension("1.3.6.1.4.1.32473.3", null, false));
    expect(view.get('[data-testid="parse-status"]').text()).toBe("Not decoded");
    expect(view.findAll("button").some((button) => button.text() === "Raw value (hex)")).toBe(true);
  });
});
