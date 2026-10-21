<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { GeneralName } from "@/client/types";
import { formatGeneralName } from "@/utils/x509";

// From worker-aia-cdp@5b570aa:src/web/components/GeneralNameList.vue: one "DNS: host" line each.
defineProps<{ names: readonly GeneralName[] }>();

const { t } = useI18n();
const label = (type: GeneralName["type"]) => t(`extension.generalName.${type}`);
</script>

<template>
  <ul class="space-y-1">
    <li v-for="(name, index) in names" :key="index" class="font-mono text-xs break-all">
      {{ formatGeneralName(name, label) }}
    </li>
  </ul>
</template>
