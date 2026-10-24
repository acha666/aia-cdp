<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Extension } from "@/client/types";
import { Accordion } from "@/components/ui/accordion";
import ExtensionView from "@/components/x509/ExtensionView.vue";

// Extensions, critical ones first, then by name (or OID), sorting a copy so the query data is
// never reordered. Any number of items can be open at once. An empty list reads "No extensions.".
const props = defineProps<{ extensions: readonly Extension[] }>();

const { t } = useI18n();

const label = (extension: Extension) => extension.extnID.name ?? extension.extnID.oid;

const items = computed(() => {
  const sorted = [...props.extensions].sort((a, b) => {
    if (a.critical !== b.critical) {
      return a.critical ? -1 : 1;
    }
    return label(a).localeCompare(label(b));
  });
  // Accordion values must be unique, and an OID can repeat (e.g. in CRL entry extensions).
  return sorted.map((extension, index) => ({
    extension,
    value: `${String(index)}-${extension.extnID.oid}`,
  }));
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
  <p v-else class="text-sm text-muted-foreground">{{ t("details.noExtensions") }}</p>
</template>
