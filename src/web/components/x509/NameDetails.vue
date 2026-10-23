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

/** CN, O, OU, C, ST, L: shown through the fields below. */
const NORMALIZED_OIDS = new Set([
  "2.5.4.3",
  "2.5.4.10",
  "2.5.4.11",
  "2.5.4.6",
  "2.5.4.8",
  "2.5.4.7",
]);

const FIELDS = [
  ["commonName", "commonName"],
  ["organization", "organization"],
  ["organizationalUnit", "organizationalUnit"],
  ["country", "countryName"],
  ["stateOrProvince", "stateProvince"],
  ["locality", "locality"],
] as const;

const items = computed(() => [
  ...FIELDS.map(([field, label]) => ({
    label: t(`nameFields.${label}`),
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
