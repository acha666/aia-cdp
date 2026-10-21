import { useTimeoutFn } from "@vueuse/core";
import { shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { copyText } from "@/utils/clipboard";

/**
 * A copy button's state: `copy(text)` puts the text on the clipboard and sets `copied` for a moment
 * (the button reads "Copied"); a failure is reported as a toast (implementation slice 5b step 4).
 */
export function useCopy() {
  const { t } = useI18n();
  const copied = shallowRef(false);
  const { start } = useTimeoutFn(
    () => {
      copied.value = false;
    },
    1500,
    { immediate: false }
  );

  async function copy(text: string): Promise<void> {
    try {
      await copyText(text);
      copied.value = true;
      start();
    } catch {
      copied.value = false;
      toast.error(t("common.copyFailed"));
    }
  }

  return { copy, copied };
}
