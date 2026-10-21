<script setup lang="ts">
import { computed } from "vue";
import type { Extension } from "@/client/types";
import { Accordion } from "@/components/ui/accordion";
import ExtensionView from "@/components/x509/ExtensionView.vue";

// From worker-aia-cdp@5b570aa:src/web/components/ExtensionList.vue: critical extensions first,
// then by name (or OID), sorting a copy so the query data is never reordered. Any number of
// items can be open at once.
const props = defineProps<{ extensions: readonly Extension[] }>();

const label = (extension: Extension) => extension.extnID.name ?? extension.extnID.oid;

const items = computed(() => {
  const sorted = [...props.extensions].sort((a, b) => {
    if (a.critical !== b.critical) {
      return a.critical ? -1 : 1;
    }
    return label(a).localeCompare(label(b));
  });
  // Accordion values must be unique; an OID can repeat (e.g. in CRL entry extensions).
  const seen = new Map<string, number>();
  return sorted.map((extension) => {
    const count = seen.get(extension.extnID.oid) ?? 0;
    seen.set(extension.extnID.oid, count + 1);
    return {
      extension,
      value: count === 0 ? extension.extnID.oid : `${extension.extnID.oid}#${String(count)}`,
    };
  });
});
</script>

<template>
  <Accordion v-if="items.length > 0" type="multiple" class="rounded-lg border px-3">
    <ExtensionView
      v-for="item in items"
      :key="item.value"
      :extension="item.extension"
      :value="item.value"
    />
  </Accordion>
</template>
