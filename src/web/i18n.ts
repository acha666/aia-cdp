import { watch } from "vue";
import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// The UI languages, en and zh-CN: the language is taken from a stored choice, else the first
// supported language in the browser's list, else en. Storage is read inside try/catch (reading
// localStorage throws where storage is blocked). Intl formats with the message locale
// (utils/dates.ts), so there is no en-GB style.

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Each language named in itself, for the language switch. */
export const LOCALE_NAMES: Record<AppLocale, string> = { en: "English", "zh-CN": "简体中文" };

/** localStorage key of the chosen language. */
export const LOCALE_STORAGE_KEY = "locale-preference";

// en is the reference schema: a key missing from zh-CN is a type error.
type MessageSchema = typeof en;

/** A language tag as a UI language: `zh*` → zh-CN, `en*` → en; else null. */
export function normalizeLocale(tag: string): AppLocale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return primary === "zh" ? "zh-CN" : primary === "en" ? "en" : null;
}

/** The stored choice, else the first supported browser language, else en. */
function detectLocale(): AppLocale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Blocked storage: no stored choice.
  }
  const locales = [stored ?? "", ...navigator.languages].map(normalizeLocale);
  return locales.find((locale) => locale !== null) ?? "en";
}

export function createAppI18n(locale: AppLocale = detectLocale()) {
  // `false`: the Composition API instance, whose global locale is a ref.
  const i18n = createI18n<[MessageSchema], AppLocale, false>({
    legacy: false,
    globalInjection: true,
    locale,
    fallbackLocale: "en",
    messages: { en, "zh-CN": zhCN },
  });
  // <html lang> follows the UI language from boot on (screen readers, hyphenation, CJK font
  // selection).
  watch(
    i18n.global.locale,
    (value) => {
      document.documentElement.lang = value;
    },
    { immediate: true }
  );
  return i18n;
}
