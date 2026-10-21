// Language detection and switching (implementation slice 5b step 8): the stored choice
// (locale-preference, old en-US / en-GB values included), the first supported browser language,
// storage that throws, <html lang>, and the choice remembered across tabs.
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocaleSelect from "@/components/LocaleSelect.vue";
import { createAppI18n, detectLocale, LOCALE_STORAGE_KEY, normalizeLocale } from "@/i18n";

let wrapper: VueWrapper | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  // Storage works again before it is cleared.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function browserLanguages(languages: string[]) {
  vi.stubGlobal("navigator", { ...navigator, languages, language: languages[0] ?? "" });
}

function mountSelect(i18n = createAppI18n()) {
  wrapper = mount(LocaleSelect, { global: { plugins: [i18n] } });
  return { select: wrapper.get("select"), i18n };
}

describe("detectLocale", () => {
  it.each([
    [["fr-FR", "zh-CN"], "zh-CN"],
    [["de", "en-AU"], "en"],
    [["zh-TW"], "zh-CN"],
    [["ZH_hans"], "zh-CN"],
    [["en-GB", "zh-CN"], "en"],
    [["fr", "de"], "en"],
    [[], "en"],
  ])("takes the first supported of %j: %s", (languages, expected) => {
    expect(detectLocale(null, languages)).toBe(expected);
  });

  it.each([
    ["en-GB", "en"],
    ["en-US", "en"],
    ["en", "en"],
    ["zh-CN", "zh-CN"],
  ])("prefers the stored %s over the browser (%s)", (stored, expected) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, stored);
    browserLanguages(stored.startsWith("zh") ? ["en-US"] : ["zh-CN"]);
    expect(detectLocale()).toBe(expected);
  });

  it("skips a stored value it does not support", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    browserLanguages(["fr-FR", "zh-CN"]);
    expect(detectLocale()).toBe("zh-CN");
    expect(normalizeLocale("fr")).toBeNull();
  });
});

describe("storage that throws", () => {
  it.each([
    [
      "reading localStorage",
      () => {
        vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        });
      },
    ],
    [
      "getItem and setItem",
      () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new DOMException("denied", "SecurityError");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("denied", "SecurityError");
        });
      },
    ],
  ])("still boots and switches when %s throws", async (_, breakStorage) => {
    browserLanguages(["zh-CN"]);
    breakStorage();
    const error = vi.spyOn(console, "error");

    expect(detectLocale()).toBe("zh-CN");
    const { select, i18n } = mountSelect();
    expect(i18n.global.locale.value).toBe("zh-CN");

    await select.setValue("en");
    await flushPromises();
    expect(i18n.global.locale.value).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    // Blocked storage only loses the memory: nothing for the console.
    expect(error).not.toHaveBeenCalled();
  });
});

describe("LocaleSelect", () => {
  it("sets <html lang> from the start and on every switch, and remembers the choice", async () => {
    const { select, i18n } = mountSelect(createAppI18n("zh-CN"));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(select.findAll("option").map((option) => option.text())).toEqual([
      "English",
      "简体中文",
    ]);
    expect((select.element as HTMLSelectElement).value).toBe("zh-CN");

    await select.setValue("en");
    await flushPromises();
    expect(i18n.global.locale.value).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    // The next visit starts in English whatever the browser prefers.
    browserLanguages(["zh-CN"]);
    expect(detectLocale()).toBe("en");
  });

  it("follows a choice made in another tab", async () => {
    const { i18n } = mountSelect(createAppI18n("en"));

    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LOCALE_STORAGE_KEY,
        newValue: "zh-CN",
        storageArea: localStorage,
      })
    );
    await flushPromises();
    expect(i18n.global.locale.value).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
