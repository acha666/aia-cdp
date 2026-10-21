// The theme (implementation slice 5b step 9): the inline script of src/web/index.html sets the dark
// class before the first paint by the rule ThemeToggle's useColorMode applies after mount, and
// the toggle cycles auto → light → dark under the same localStorage key.
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThemeToggle from "@/components/ThemeToggle.vue";
import { createAppI18n } from "@/i18n";
import indexHtml from "@/index.html?raw";

const KEY = "theme-preference";
const html = document.documentElement;

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  html.className = "";
});

/** The classic inline scripts of index.html (the module entry has a src). */
const inlineScripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1]!
);

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: dark && query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
  );
}

function runPrePaint() {
  // The script as the browser runs it: global code reading localStorage and matchMedia.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const script = new Function(inlineScripts[0]!) as () => void;
  script();
}

describe("index.html pre-paint script", () => {
  it("is the page's only inline script", () => {
    expect(inlineScripts).toHaveLength(1);
    expect(indexHtml).toMatch(/<script type="module" src="\/main.ts"><\/script>/);
  });

  it.each([
    ["dark", false, true],
    ["dark", true, true],
    ["light", true, false],
    ["auto", true, true],
    ["auto", false, false],
    [null, true, true],
    [null, false, false],
    ["something else", true, false],
  ])("stored %s, system dark %s → dark class %s", (stored, systemDark, dark) => {
    if (stored !== null) {
      localStorage.setItem(KEY, stored);
    }
    systemPrefersDark(systemDark);
    runPrePaint();
    expect(html.classList.contains("dark")).toBe(dark);
  });

  it("does nothing, and throws nothing, when storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    systemPrefersDark(true);
    expect(runPrePaint).not.toThrow();
    expect(html.classList.contains("dark")).toBe(false);
  });
});

describe("ThemeToggle", () => {
  function mountToggle() {
    wrapper = mount(ThemeToggle, { global: { plugins: [createAppI18n("en")] } });
    return wrapper.get("button");
  }

  it("keeps a stored dark preference and cycles auto → light → dark under the same key", async () => {
    localStorage.setItem(KEY, "dark");
    systemPrefersDark(false);
    runPrePaint();
    expect(html.classList.contains("dark")).toBe(true);

    const createElement = vi.spyOn(document, "createElement");
    const button = mountToggle();
    await flushPromises();
    expect(html.classList.contains("dark")).toBe(true);
    expect(button.attributes("data-preference")).toBe("dark");
    expect(button.attributes("aria-label")).toBe("Theme: dark. Switch to system");

    await button.trigger("click");
    await flushPromises();
    expect(localStorage.getItem(KEY)).toBe("auto");
    // The system prefers light here.
    expect(html.classList.contains("dark")).toBe(false);

    await button.trigger("click");
    await flushPromises();
    expect(localStorage.getItem(KEY)).toBe("light");
    expect(html.classList.contains("light")).toBe(true);

    await button.trigger("click");
    await flushPromises();
    expect(localStorage.getItem(KEY)).toBe("dark");
    expect(html.classList.contains("dark")).toBe(true);
    // Without disableTransition, useColorMode creates no <style> element (CSP style-src 'self').
    expect(createElement.mock.calls.filter(([tag]) => tag === "style")).toEqual([]);
  });

  it("still cycles, without console errors, when storage is blocked", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    systemPrefersDark(false);
    const error = vi.spyOn(console, "error");

    const button = mountToggle();
    await flushPromises();
    await button.trigger("click");
    await flushPromises();
    expect(button.attributes("data-preference")).toBe("light");
    expect(html.classList.contains("light")).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
