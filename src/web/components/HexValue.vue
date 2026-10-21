<script setup lang="ts">
import { CheckIcon, CopyIcon } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/composables/useCopy";
import { formatHexGroups, normalizeHexForCopy } from "@/utils/format";

// A hex value in monospace with a copy button (worker-aia-cdp@5b570aa:src/web/components/
// HexValue.vue). "grouped" shows bytes as AB:CD and wraps only after a colon (<wbr>, which a
// selection does not copy); "plain" shows the digits as they are. The copy button puts the bare
// upper-case digits on the clipboard (useCopy: a failure is reported as a toast).
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
const { copy, copied } = useCopy();

const copyValue = computed(() => (props.value ? normalizeHexForCopy(props.value) : ""));
const groups = computed(() =>
  copyValue.value && props.variant === "grouped" ? formatHexGroups(copyValue.value) : null
);
const copyLabel = computed(() => (copied.value ? t("common.copied") : t("common.copy")));
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
      @click="copy(copyValue)"
    >
      <CheckIcon v-if="copied" />
      <CopyIcon v-else />
    </Button>
  </component>
</template>
