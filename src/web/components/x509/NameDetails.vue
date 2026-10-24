<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Name } from "@/client/types";
import KeyValueList from "@/components/KeyValueList.vue";

// A distinguished name: the RFC 4514 string, the six usual attributes (always listed, "(empty)"
// when absent) and every other attribute of the RDNs (DC, emailAddress, serialNumber, ...), whose
// string type shows on hover.
const props = defineProps<{ name: Name; title?: string }>();

const { t } = useI18n();

/** CN, O, OU, C, ST, L: the Name field and the attribute type it comes from. */
const FIELDS = [
  ["commonName", "2.5.4.3"],
  ["organization", "2.5.4.10"],
  ["organizationalUnit", "2.5.4.11"],
  ["country", "2.5.4.6"],
  ["stateOrProvince", "2.5.4.8"],
  ["locality", "2.5.4.7"],
] as const;
/** The attributes the fields show; the others are listed one by one. */
const NORMALIZED_OIDS = new Set<string>(FIELDS.map(([, oid]) => oid));

const items = computed(() => [
  ...FIELDS.map(([field]) => ({
    label: t(`nameFields.${field}`),
    value: props.name[field]?.trim() ?? "",
  })),
  ...props.name.rdnSequence
    .flatMap((rdn) => rdn.attributes)
    .filter((attribute) => !NORMALIZED_OIDS.has(attribute.type.oid))
    .map((attribute) => ({
      label: attribute.type.name ?? attribute.type.oid,
      value: attribute.value.string ?? `#${attribute.value.rawHex ?? ""}`,
      title: attribute.value.encoding,
    })),
]);
</script>

<template>
  <section class="space-y-2">
    <h2 v-if="title" class="text-sm font-medium">{{ title }}</h2>
    <p v-if="name.rfc4514" class="font-mono text-xs break-all text-muted-foreground">
      {{ name.rfc4514 }}
    </p>
    <KeyValueList :items="items" />
  </section>
</template>
