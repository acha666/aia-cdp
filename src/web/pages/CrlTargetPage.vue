<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { I18nT, useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useCrlTarget } from "@/client/queries";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import QueryError from "@/components/QueryError.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { useClock } from "@/composables/useClock";
import { useDateText } from "@/composables/useDateText";
import { usePageTitle } from "@/composables/usePageTitle";
import { formatDateTimeWithZone, getRelativeTimeDetailed } from "@/utils/dates";
import { isNotFound } from "@/utils/errors";
import { issuerName } from "@/utils/labels";
import { computeTargetStatus } from "@/utils/status";
import { formatAlgorithm } from "@/utils/x509";

// One CRL target (plan §8; replaces slice 1's CrlPage.vue, after worker-aia-cdp@5b570aa:src/web/
// components/CrlDetails.vue): header with label, kind, status and downloads, then the current CRL
// in tabs (overview with the issuer link, CRL and base CRL numbers, thisUpdate / nextUpdate / Next
// CRL Publish, algorithm and fingerprints; revoked certificates; extensions). A target without a
// current CRL says it is not published instead. `targetId` matched the router's pattern.
const props = defineProps<{ targetId: string }>();

const { t } = useI18n();
const now = useClock();
const dateText = useDateText();
const { data, isError, error, refetch } = useCrlTarget(() => props.targetId);

usePageTitle(() => data.value?.label ?? t("pages.crl.title"));

const missing = computed(() => data.value === undefined && isNotFound(error.value));
const current = computed(() => data.value?.current ?? null);
const status = computed(() => computeTargetStatus(current.value, now.value.getTime()));
const issuer = computed(() =>
  data.value ? (issuerName(data.value.issuer) ?? t("common.unknown")) : ""
);
const extensions = computed(() => current.value?.tbsCertList.crlExtensions?.items ?? []);

const salt = (length: number) => t("algorithm.salt", { length });
const time = (iso: string | null | undefined) => formatDateTimeWithZone(iso, dateText);

/** The overview of the current CRL, in sections; the issuer link and the status are in the header. */
const overview = computed(() => {
  const crl = current.value;
  if (crl === null) {
    return null;
  }
  const { summary } = crl;
  return {
    information: [
      { label: t("details.crl.crlNumber"), value: summary.crlNumber },
      ...(summary.baseCrlNumber === null
        ? []
        : [{ label: t("details.crl.baseCrlNumber"), value: summary.baseCrlNumber }]),
      { label: t("details.crl.version"), value: crl.tbsCertList.version.display },
      { label: t("details.crl.publishedAt"), value: time(crl.publishedAt) },
      { label: t("details.crl.size"), value: t("common.bytes", { count: crl.size }) },
    ],
    validity: [
      { label: t("details.crl.thisUpdate"), value: time(summary.thisUpdate) },
      { label: t("details.crl.nextUpdate"), value: time(summary.nextUpdate) },
      ...(summary.nextPublish === null
        ? []
        : [{ label: t("details.crl.nextPublish"), value: time(summary.nextPublish) }]),
    ],
    cryptography: [
      {
        label: t("details.crl.signatureAlgorithm"),
        value: formatAlgorithm(crl.signatureAlgorithm, salt) ?? t("common.unknown"),
      },
    ],
    fingerprints: [
      { label: "SHA-1", value: crl.fingerprints.sha1, hex: true },
      { label: "SHA-256", value: crl.fingerprints.sha256, hex: true },
    ],
  };
});

const SECTIONS = ["information", "validity", "cryptography", "fingerprints"] as const;

/** Time to nextUpdate (or since it, once expired), next to the status badge. */
const statusDetail = computed(() => {
  const summary = current.value?.summary;
  if (!summary || status.value.state === "unknown") {
    return null;
  }
  return getRelativeTimeDetailed(summary.nextUpdate, now.value.getTime(), dateText) || null;
});

const tab = ref("overview");
watch(
  () => props.targetId,
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
          <h1 class="text-2xl font-semibold tracking-tight break-all">{{ data.label }}</h1>
          <KindBadge :kind="data.kind" />
          <StatusBadge :state="status.state" />
          <span
            v-if="statusDetail"
            class="text-sm text-muted-foreground"
            data-testid="status-detail"
          >
            ({{ statusDetail }})
          </span>
        </div>
        <I18nT keypath="details.crl.issuedBy" tag="p" class="text-sm text-muted-foreground">
          <template #issuer>
            <RouterLink
              :to="{ name: 'certificate', params: { id: data.issuer.id } }"
              class="text-foreground underline-offset-4 hover:underline"
              data-testid="issuer-link"
            >
              {{ issuer }}
            </RouterLink>
          </template>
        </I18nT>
        <DownloadLinks :downloads="data.downloads" />
      </header>

      <div
        v-if="current === null"
        class="rounded-lg border border-dashed p-4"
        data-testid="unpublished"
      >
        <p class="font-medium">{{ t("crl.unpublished") }}</p>
        <p class="text-sm text-muted-foreground">{{ t("details.crl.unpublishedBody") }}</p>
      </div>

      <Tabs v-else v-model="tab">
        <TabsList>
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="revoked">
            {{ t("details.crl.revokedCertificates") }}
            ({{ current.tbsCertList.revokedCertificates.count }})
          </TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.crl.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" class="grid gap-6 pt-2" data-testid="crl-overview">
          <template v-if="overview">
            <section v-for="section in SECTIONS" :key="section" class="space-y-2">
              <h3 class="text-sm font-medium">{{ t(`details.crl.${section}`) }}</h3>
              <KeyValueList :items="overview[section]" />
            </section>
          </template>
          <NameDetails :name="current.tbsCertList.issuer" :title="t('details.crl.issuer')" />
        </TabsContent>
        <TabsContent value="revoked" class="pt-2">
          <RevokedTable :revoked="current.tbsCertList.revokedCertificates" />
        </TabsContent>
        <TabsContent value="extensions" class="pt-2">
          <ExtensionList :extensions="extensions" />
          <p v-if="extensions.length === 0" class="text-sm text-muted-foreground">
            {{ t("details.noExtensions") }}
          </p>
        </TabsContent>
      </Tabs>
    </template>

    <div v-else-if="missing" class="grid gap-2" data-testid="missing">
      <h1 class="text-2xl font-semibold tracking-tight">{{ t("details.crl.notFoundTitle") }}</h1>
      <p class="text-muted-foreground">{{ t("details.crl.notFound") }}</p>
      <code class="font-mono text-xs break-all text-muted-foreground">{{ targetId }}</code>
    </div>

    <QueryError
      v-else-if="isError"
      :error="error"
      :title="t('details.crl.loadFailed')"
      @retry="refetch()"
    />

    <div v-else class="grid gap-3" data-testid="detail-skeleton">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-5 w-40" />
      <Skeleton class="h-48 w-full" />
    </div>
  </section>
</template>
