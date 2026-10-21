// Shared display components (implementation slice 5b step 4), mounted in happy-dom. Rewrite of
// worker-aia-cdp@5b570aa:tests/web/components.test.ts (SSR render through a Vite server there):
// its ResourceCard case becomes the DownloadLinks case, and its CRL details case moves to
// revoked-table.test.ts with the revoked table.
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import { toast } from "vue-sonner";
import DownloadLinks from "@/components/DownloadLinks.vue";
import HexValue from "@/components/HexValue.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import LocaleSelect from "@/components/LocaleSelect.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  // happy-dom has no execCommand; the HexValue tests install one for useClipboard's legacy path.
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
      downloads: ["/ca/nested/root.crt", "/ca/nested/root.crt.pem", "/ca/root-legacy.cer"],
    }).findAll("a");
    expect(links.map((link) => [link.attributes("href"), link.attributes("data-format")])).toEqual([
      ["/ca/nested/root.crt", "DER"],
      ["/ca/nested/root.crt.pem", "PEM"],
      ["/ca/root-legacy.cer", "DER"],
    ]);
    expect(links.every((link) => link.attributes("download") !== undefined)).toBe(true);
    expect(links[1]!.text()).toBe("PEM: /ca/nested/root.crt.pem");
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
  it("groups bytes without spaces and copies the bare digits", async () => {
    // The Clipboard API refuses: useClipboard({ legacy: true }) copies a selected <textarea>.
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: () => Promise.reject(new Error("ClipboardItem unsupported")),
      },
    });
    const copied: string[] = [];
    document.execCommand = vi.fn((command: string) => {
      copied.push(`${command}:${document.querySelector("textarea")?.value ?? ""}`);
      return true;
    });

    const hex = render(HexValue, { value: "0a:1b 2c", variant: "grouped" });
    expect(hex.get('[data-testid="hex-value"]').element.textContent).toBe("0A:1B:2C");
    expect(hex.findAll("wbr")).toHaveLength(3);
    const button = hex.get("button");
    expect(button.attributes("aria-label")).toBe("Copy");
    await button.trigger("click");
    await flushPromises();
    expect(copied).toEqual(["copy:0A1B2C"]);
    expect(button.attributes("aria-label")).toBe("Copied");
  });

  it("reports a failed copy as a toast", async () => {
    // No Clipboard API and no document.execCommand (as in happy-dom): the legacy copy throws.
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
