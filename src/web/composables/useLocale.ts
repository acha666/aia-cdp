import { useStorage } from "@vueuse/core";
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALE_STORAGE_KEY, normalizeLocale } from "@/i18n";
import type { AppLocale } from "@/i18n";

/**
 * The UI language as a writable ref. Setting it switches vue-i18n's global locale (i18n.ts mirrors
 * it to <html lang>) and remembers the choice under locale-preference; useStorage catches every
 * storage error, so blocked storage only loses the memory (and is not worth a console error). A
 * choice made in another tab (storage event) applies here too.
 */
export function useLocale() {
  const { locale } = useI18n({ useScope: "global" });
  const stored = useStorage<string | null>(LOCALE_STORAGE_KEY, null, undefined, {
    onError: () => undefined,
  });

  watch(stored, (value) => {
    const next = value === null ? null : normalizeLocale(value);
    if (next !== null) {
      locale.value = next;
    }
  });

  return computed<AppLocale>({
    get: () => locale.value as AppLocale,
    set: (value) => {
      locale.value = value;
      stored.value = value;
    },
  });
}
