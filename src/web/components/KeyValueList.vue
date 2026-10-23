<script setup lang="ts">
import { useI18n } from "vue-i18n";
import HexValue from "@/components/HexValue.vue";

// Label / value pairs as a description list, shared by the detail views. Rows of extension blocks
// (utils/extension-blocks.ts) fit as they are. An empty value reads "(empty)" rather than a blank
// cell; the `value` slot replaces the default rendering of any item.
interface KeyValueItem {
  label: string;
  value: string | null | undefined;
  /** Grouped hex with a copy button. */
  hex?: boolean;
  /** Tooltip of the label (e.g. the string type of a name attribute). */
  title?: string;
}

defineProps<{ items: readonly KeyValueItem[] }>();
defineSlots<{ value?: (props: { item: KeyValueItem; index: number }) => unknown }>();

const { t } = useI18n();
</script>

<template>
  <dl
    class="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-y-2"
  >
    <template v-for="(item, index) in items" :key="index">
      <dt class="text-muted-foreground sm:break-words" :title="item.title">{{ item.label }}</dt>
      <dd class="mb-2 min-w-0 break-words sm:mb-0">
        <slot name="value" :item="item" :index="index">
          <HexValue v-if="item.hex && item.value" :value="item.value" variant="grouped" />
          <span v-else-if="item.value" class="whitespace-pre-wrap">{{ item.value }}</span>
          <span v-else class="text-muted-foreground">{{ t("common.emptyValue") }}</span>
        </slot>
      </dd>
    </template>
  </dl>
</template>
