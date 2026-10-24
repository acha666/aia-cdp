<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useCertificate } from "@/client/queries";
import CertificateOverview from "@/components/certificate/CertificateOverview.vue";
import DetailLayout from "@/components/DetailLayout.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KindBadge from "@/components/KindBadge.vue";
import PemText from "@/components/PemText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import { useClock } from "@/composables/useClock";
import { certificateName } from "@/utils/labels";
import { computeCertificateStatus } from "@/utils/status";

// One certificate (plan §8), in DetailLayout's frame: header with name, status and downloads; tabs
// for the overview, the extensions and, when the configuration serves a .pem path, the PEM text.
// `id` matched the router's pattern, so it is safe to put into the request URL. The tabs may not
// widen the page (min-w-0: the PEM text and ASN.1 dumps scroll in their own boxes, the tab list
// scrolls sideways on a phone, never down: the triggers' hidden line-variant ::after reaches below
// it); the panels are tab stops (Reka), so they show a focus ring. The tabs are keyed by `id`:
// another certificate (a link from a target page) starts on its overview.
const props = defineProps<{ id: string }>();

const { t } = useI18n();
const now = useClock();
const { data, error, refetch } = useCertificate(() => props.id);

const name = computed(
  () => data.value && (certificateName(data.value) ?? t("details.certificate.unknownName"))
);

const state = computed(() => {
  const summary = data.value?.summary;
  return summary
    ? computeCertificateStatus(summary.notBefore, summary.notAfter, now.value.getTime())
    : null;
});
const extensions = computed(() => data.value?.tbsCertificate.extensions?.items ?? []);
const pemPath = computed(() => data.value?.downloads.find((path) => path.endsWith(".pem")) ?? null);

const PANEL = "rounded-md pt-2 focus-visible:ring-3 focus-visible:ring-ring/50";
</script>

<template>
  <DetailLayout :id="id" kind="certificate" :name="name" :error="error" @retry="refetch()">
    <template v-if="data">
      <header class="grid gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-semibold tracking-tight break-all">{{ name }}</h1>
          <KindBadge kind="certificate" />
          <StatusBadge v-if="state" :state="state" />
        </div>
        <p
          v-if="data.label !== null && data.summary.subjectCN"
          class="text-sm text-muted-foreground"
        >
          {{ data.summary.subjectCN }}
        </p>
        <DownloadLinks :downloads="data.downloads" />
      </header>

      <Tabs :key="id" default-value="overview" class="min-w-0">
        <TabsList class="max-w-full justify-start overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.certificate.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
          <TabsTrigger v-if="pemPath" value="raw">{{ t("details.tabs.raw") }}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" :class="PANEL">
          <CertificateOverview :certificate="data" />
        </TabsContent>
        <TabsContent value="extensions" :class="PANEL">
          <!-- The extensions' accordion headings are h3. -->
          <h2 class="sr-only">{{ t("details.certificate.extensions") }}</h2>
          <ExtensionList :extensions="extensions" />
          <p v-if="extensions.length === 0" class="text-sm text-muted-foreground">
            {{ t("details.noExtensions") }}
          </p>
        </TabsContent>
        <TabsContent v-if="pemPath" value="raw" :class="PANEL">
          <PemText :path="pemPath" />
        </TabsContent>
      </Tabs>
    </template>
  </DetailLayout>
</template>
