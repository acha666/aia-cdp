<script setup lang="ts">
import { CheckIcon, CopyIcon } from "@lucide/vue";
import { computed } from "vue";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/composables/useCopy";

// A hex value (the API's bare digits) in monospace with a copy button. Bytes show as AB:CD and wrap
// only after a colon (<wbr>, which a selection does not copy). The copy button puts the upper-case
// digits on the clipboard (useCopy: a failure is reported as a toast).
const props = withDefaults(
  defineProps<{
    value?: string | null;
    /** A block (flex) instead of an inline element. */
    block?: boolean;
  }>(),
  { value: null, block: false }
);

const { copy, copied, label } = useCopy();

const digits = computed(() => props.value?.toUpperCase() ?? "");
const groups = computed(() => digits.value.match(/.{1,2}/g) ?? []);
</script>

<template>
  <component
    :is="block ? 'div' : 'span'"
    class="min-w-0 items-baseline gap-1"
    :class="block ? 'flex' : 'inline-flex'"
  >
    <span class="min-w-0 font-mono break-words" data-testid="hex-value">
      <span v-for="(group, index) in groups" :key="index"
        >{{ index < groups.length - 1 ? `${group}:` : group }}<wbr
      /></span>
    </span>
    <Button
      v-if="digits"
      type="button"
      variant="ghost"
      size="icon-xs"
      class="self-center text-muted-foreground"
      :aria-label="label"
      :title="label"
      @click="copy(digits)"
    >
      <CheckIcon v-if="copied" />
      <CopyIcon v-else />
    </Button>
  </component>
</template>
