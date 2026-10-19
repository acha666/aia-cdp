import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Each language named in itself, for the language switch. */
export const LOCALE_NAMES: Record<AppLocale, string> = { en: "English", "zh-CN": "简体中文" };

// en is the reference schema: a key missing from zh-CN is a type error.
type MessageSchema = typeof en;

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/**
 * First supported entry of the browser's preferred languages (`zh*` → zh-CN, `en*` → en; others
 * are skipped), else en. Slice 5b puts a stored preference in front of this.
 */
export function detectLocale(languages: readonly string[] = browserLanguages()): AppLocale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split("-")[0];
    if (primary === "zh") {
      return "zh-CN";
    }
    if (primary === "en") {
      return "en";
    }
  }
  return "en";
}

export function createAppI18n(locale: AppLocale = detectLocale()) {
  return createI18n<[MessageSchema], AppLocale>({
    legacy: false,
    globalInjection: true,
    locale,
    fallbackLocale: "en",
    messages: { en, "zh-CN": zhCN },
  });
}
