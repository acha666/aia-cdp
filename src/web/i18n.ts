import { watch } from "vue";
import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// The UI languages (implementation slice 5b step 8), from worker-aia-cdp@5b570aa:src/web/i18n.ts:
// en and zh-CN instead of en / en-US / en-GB, the language taken from a stored choice, else the
// first supported browser language (the old normalizeLocale never returned null, so only the first
// one was ever looked at), else en. The stored choice keeps the old key; storage is read inside
// try/catch (the old module read localStorage bare at import time, which throws where storage is
// blocked). Intl formats with the message locale (utils/dates.ts), so there is no en-GB style.

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Each language named in itself, for the language switch. */
export const LOCALE_NAMES: Record<AppLocale, string> = { en: "English", "zh-CN": "简体中文" };

/** localStorage key of the chosen language (the old UI's, which stored en / en-US / en-GB). */
export const LOCALE_STORAGE_KEY = "locale-preference";

// en is the reference schema: a key missing from zh-CN is a type error.
type MessageSchema = typeof en;

/** A language tag as a UI language: `zh*` → zh-CN, `en*` → en (old en-US / en-GB too); else null. */
export function normalizeLocale(tag: string): AppLocale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "zh") {
    return "zh-CN";
  }
  if (primary === "en") {
    return "en";
  }
  return null;
}

/** The stored choice; null without one, with an unsupported one, or when storage is unavailable. */
export function storedLocale(): AppLocale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === null ? null : normalizeLocale(value);
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** The stored choice, else the first supported browser language, else en. */
export function detectLocale(
  stored: AppLocale | null = storedLocale(),
  languages: readonly string[] = browserLanguages()
): AppLocale {
  if (stored !== null) {
    return stored;
  }
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale !== null) {
      return locale;
    }
  }
  return "en";
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
