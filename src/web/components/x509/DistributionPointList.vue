<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { DistributionPoint } from "@/client/types";
import GeneralNameList from "@/components/x509/GeneralNameList.vue";
import TagList from "@/components/x509/TagList.vue";
import { formatAttribute } from "@/utils/x509";

// From worker-aia-cdp@5b570aa:src/web/components/DistributionPointList.vue: the name (full name
// or relative to the CRL issuer), the reasons and the CRL issuer of each point.
defineProps<{ points: readonly DistributionPoint[] }>();

const { t } = useI18n();
</script>

<template>
  <ul class="space-y-2">
    <li v-for="(point, index) in points" :key="index" class="space-y-1 text-xs">
      <GeneralNameList
        v-if="point.distributionPoint?.fullName"
        :names="point.distributionPoint.fullName"
      />
      <p v-else-if="point.distributionPoint?.nameRelativeToCRLIssuer" class="break-all">
        <!-- The space is part of the label: whitespace between the two spans is not kept. -->
        <span class="text-muted-foreground">{{
          `${t("extension.fields.nameRelativeToCRLIssuer")}: `
        }}</span>
        <span class="font-mono">{{
          point.distributionPoint.nameRelativeToCRLIssuer.attributes.map(formatAttribute).join("+")
        }}</span>
      </p>
      <div v-if="point.reasons?.length" class="flex flex-wrap items-center gap-1">
        <span class="text-muted-foreground">{{ t("extension.fields.reasons") }}:</span>
        <TagList :tags="point.reasons" tone="amber" />
      </div>
      <div v-if="point.cRLIssuer?.length">
        <span class="text-muted-foreground">{{ t("extension.fields.crlIssuer") }}:</span>
        <GeneralNameList :names="point.cRLIssuer" />
      </div>
    </li>
  </ul>
</template>
