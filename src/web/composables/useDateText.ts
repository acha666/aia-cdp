import { useI18n } from "vue-i18n";
import type { DateText } from "@/utils/dates";

/**
 * The DateText of the component's i18n scope for the formatters in utils/dates.ts. `locale` is a
 * getter, so a computed that formats a date re-runs when the language changes.
 */
export function useDateText(): DateText {
  const { locale, t } = useI18n();
  return {
    get locale() {
      return locale.value;
    },
    t: (key, named) => (named === undefined ? t(key) : t(key, named)),
  };
}
