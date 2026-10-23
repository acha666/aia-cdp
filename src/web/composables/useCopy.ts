import { refAutoReset } from "@vueuse/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { copyText } from "@/utils/clipboard";

/**
 * A copy button's state: `copy(text)` puts the text on the clipboard and sets `copied` for a moment
 * (`label` reads "Copied" then, else "Copy"); a failure is reported as a toast.
 */
export function useCopy() {
  const { t } = useI18n();
  const copied = refAutoReset(false, 1500);
  const label = computed(() => t(copied.value ? "common.copied" : "common.copy"));

  async function copy(text: string): Promise<void> {
    try {
      await copyText(text);
      copied.value = true;
    } catch {
      copied.value = false;
      toast.error(t("common.copyFailed"));
    }
  }

  return { copy, copied, label };
}
