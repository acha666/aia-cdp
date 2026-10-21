<script setup lang="ts">
import { CheckIcon, CopyIcon } from "@lucide/vue";
import { useClipboard } from "@vueuse/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { formatHexGroups, normalizeHexForCopy } from "@/utils/format";

// A hex value in monospace with a copy button (worker-aia-cdp@5b570aa:src/web/components/
// HexValue.vue). "grouped" shows bytes as AB:CD and wraps only after a colon (<wbr>, which a
// selection does not copy); "plain" shows the digits as they are. The copy button puts the bare
// upper-case digits on the clipboard; a failure to do so is reported as a toast.
const props = withDefaults(
  defineProps<{
    value?: string | null;
    variant?: "grouped" | "plain";
    showCopy?: boolean;
    /** A block (flex) instead of an inline element. */
    block?: boolean;
    /** Shown without a value. */
    fallback?: string;
  }>(),
  { value: null, variant: "plain", showCopy: true, block: false, fallback: "" }
);

const { t } = useI18n();
// legacy: document.execCommand("copy") where the Clipboard API is missing or denied (plain HTTP).
const { copy, copied } = useClipboard({ legacy: true });

const copyValue = computed(() => (props.value ? normalizeHexForCopy(props.value) : ""));
const groups = computed(() =>
  copyValue.value && props.variant === "grouped" ? formatHexGroups(copyValue.value) : null
);
const copyLabel = computed(() => (copied.value ? t("common.copied") : t("common.copy")));

async function copyHex() {
  try {
    await copy(copyValue.value);
  } catch {
    toast.error(t("common.copyFailed"));
  }
}
</script>

<template>
  <component
    :is="block ? 'div' : 'span'"
    class="min-w-0 items-baseline gap-1"
    :class="block ? 'flex' : 'inline-flex'"
  >
    <span
      class="min-w-0 font-mono"
      :class="groups ? 'break-words' : 'break-all'"
      data-testid="hex-value"
    >
      <template v-if="groups">
        <span v-for="(group, index) in groups" :key="index"
          >{{ index < groups.length - 1 ? `${group}:` : group }}<wbr
        /></span>
      </template>
      <template v-else>{{ value || fallback }}</template>
    </span>
    <Button
      v-if="showCopy && copyValue"
      type="button"
      variant="ghost"
      size="icon-xs"
      class="self-center text-muted-foreground"
      :aria-label="copyLabel"
      :title="copyLabel"
      @click="copyHex"
    >
      <CheckIcon v-if="copied" />
      <CopyIcon v-else />
    </Button>
  </component>
</template>
