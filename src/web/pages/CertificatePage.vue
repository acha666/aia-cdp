<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useCertificate } from "@/client/queries";
import CertificateOverview from "@/components/certificate/CertificateOverview.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KindBadge from "@/components/KindBadge.vue";
import PemText from "@/components/PemText.vue";
import QueryError from "@/components/QueryError.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import { useClock } from "@/composables/useClock";
import { usePageTitle } from "@/composables/usePageTitle";
import { isNotFound } from "@/utils/errors";
import { certificateName } from "@/utils/labels";
import { computeCertificateStatus } from "@/utils/status";

// One certificate (plan §8): header with name, status and downloads; tabs for the overview, the
// extensions and, when the configuration serves a .pem path, the PEM text. `id` matched the
// router's pattern, so it is safe to put into the request URL.
const props = defineProps<{ id: string }>();

const { t } = useI18n();
const now = useClock();
const { data, isError, error, refetch } = useCertificate(() => props.id);

const name = computed(() => {
  if (data.value === undefined) {
    return t("pages.certificate.title");
  }
  return certificateName(data.value) ?? t("details.certificate.unknownName");
});
usePageTitle(name);

const missing = computed(() => data.value === undefined && isNotFound(error.value));
const state = computed(() => {
  const summary = data.value?.summary;
  return summary
    ? computeCertificateStatus(summary.notBefore, summary.notAfter, now.value.getTime()).state
    : null;
});
const extensions = computed(() => data.value?.tbsCertificate.extensions?.items ?? []);
const pemPath = computed(() => data.value?.downloads.find((path) => path.endsWith(".pem")) ?? null);

const tab = ref("overview");
// Another certificate (a link from a target page) starts on its overview.
watch(
  () => props.id,
  () => {
    tab.value = "overview";
  }
);
</script>

<template>
  <section class="grid gap-4">
    <Button as-child variant="ghost" size="sm" class="w-fit">
      <RouterLink to="/">
        <ArrowLeftIcon data-icon="inline-start" />
        {{ t("nav.backToOverview") }}
      </RouterLink>
    </Button>

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

      <Tabs v-model="tab">
        <TabsList>
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.certificate.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
          <TabsTrigger v-if="pemPath" value="raw">{{ t("details.tabs.raw") }}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" class="pt-2">
          <CertificateOverview :certificate="data" />
        </TabsContent>
        <TabsContent value="extensions" class="pt-2">
          <ExtensionList :extensions="extensions" />
          <p v-if="extensions.length === 0" class="text-sm text-muted-foreground">
            {{ t("details.noExtensions") }}
          </p>
        </TabsContent>
        <TabsContent v-if="pemPath" value="raw" class="pt-2">
          <PemText :path="pemPath" />
        </TabsContent>
      </Tabs>
    </template>

    <div v-else-if="missing" class="grid gap-2" data-testid="missing">
      <h1 class="text-2xl font-semibold tracking-tight">
        {{ t("details.certificate.notFoundTitle") }}
      </h1>
      <p class="text-muted-foreground">{{ t("details.certificate.notFound") }}</p>
      <code class="font-mono text-xs break-all text-muted-foreground">{{ id }}</code>
    </div>

    <QueryError
      v-else-if="isError"
      :error="error"
      :title="t('details.certificate.loadFailed')"
      @retry="refetch()"
    />

    <div v-else class="grid gap-3" data-testid="detail-skeleton">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-5 w-40" />
      <Skeleton class="h-48 w-full" />
    </div>
  </section>
</template>
