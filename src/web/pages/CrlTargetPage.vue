<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { computed } from "vue";
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
import { usePageTitle } from "@/composables/usePageTitle";
import { formatDate, relativeTime } from "@/utils/dates";
import { isNotFound } from "@/utils/errors";
import { issuerName } from "@/utils/labels";
import { computeTargetStatus } from "@/utils/status";
import { rows } from "@/utils/values";
import { formatAlgorithm } from "@/utils/x509";

// One CRL target (plan §8): header with label, kind, status and downloads, then the current CRL in
// tabs (overview with the issuer link, CRL and base CRL numbers, thisUpdate / nextUpdate / Next CRL
// Publish, algorithm and fingerprints; revoked certificates; extensions). A target without a
// current CRL says it is not published instead, and offers no downloads (its paths answer 404).
// `targetId` matched the router's pattern. Tabs and panels as on CertificatePage.
const props = defineProps<{ targetId: string }>();

const i18n = useI18n();
const { t } = i18n;
const now = useClock();
const { data, isError, error, refetch } = useCrlTarget(() => props.targetId);

const missing = computed(() => data.value === undefined && isNotFound(error.value));
usePageTitle(
  () => data.value?.label ?? t(missing.value ? "details.crl.notFoundTitle" : "pages.crl.title")
);

const current = computed(() => data.value?.current ?? null);
const status = computed(() => computeTargetStatus(current.value, now.value.getTime()));
const issuer = computed(() =>
  data.value ? (issuerName(data.value.issuer) ?? t("common.unknown")) : ""
);
const extensions = computed(() => current.value?.tbsCertList.crlExtensions?.items ?? []);

const time = (iso: string | null | undefined) => formatDate(iso, i18n);

/** The overview of the current CRL, in sections; the issuer link and the status are in the header. */
const overview = computed(() => {
  const crl = current.value;
  if (crl === null) {
    return null;
  }
  const { summary } = crl;
  return {
    information: rows(
      { label: t("details.crl.crlNumber"), value: summary.crlNumber },
      summary.baseCrlNumber !== null && {
        label: t("details.crl.baseCrlNumber"),
        value: summary.baseCrlNumber,
      },
      { label: t("details.crl.version"), value: crl.tbsCertList.version.display },
      { label: t("details.crl.publishedAt"), value: time(crl.publishedAt) },
      { label: t("details.crl.size"), value: t("common.bytes", { count: crl.size }) }
    ),
    validity: rows(
      { label: t("details.crl.thisUpdate"), value: time(summary.thisUpdate) },
      { label: t("details.crl.nextUpdate"), value: time(summary.nextUpdate) },
      summary.nextPublish !== null && {
        label: t("details.crl.nextPublish"),
        value: time(summary.nextPublish),
      }
    ),
    cryptography: [
      {
        label: t("details.crl.signatureAlgorithm"),
        value: formatAlgorithm(crl.signatureAlgorithm, i18n),
      },
    ],
    fingerprints: [
      { label: "SHA-1", value: { hex: crl.fingerprints.sha1 } },
      { label: "SHA-256", value: { hex: crl.fingerprints.sha256 } },
    ],
  };
});

const SECTIONS = ["information", "validity", "cryptography", "fingerprints"] as const;

/**
 * Time to nextUpdate (or since it, once expired) next to the status badge; to thisUpdate while not
 * yet valid (a browser clock behind the server's), as the certificate overview does.
 */
const statusDetail = computed(() => {
  const summary = current.value?.summary;
  if (!summary || status.value === "unknown") {
    return null;
  }
  const boundary = status.value === "not-yet-valid" ? summary.thisUpdate : summary.nextUpdate;
  return relativeTime(boundary, now.value.getTime(), i18n, true) || null;
});

const PANEL = "rounded-md pt-2 focus-visible:ring-3 focus-visible:ring-ring/50";
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
          <StatusBadge :state="status" />
          <span
            v-if="statusDetail"
            class="text-sm text-muted-foreground"
            data-testid="status-detail"
          >
            ({{ statusDetail }})
          </span>
        </div>
        <I18nT
          keypath="details.crl.issuedBy"
          scope="global"
          tag="p"
          class="text-sm text-muted-foreground"
        >
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
        <DownloadLinks :downloads="current === null ? [] : data.downloads" />
      </header>

      <div
        v-if="current === null"
        class="rounded-lg border border-dashed p-4"
        data-testid="unpublished"
      >
        <p class="font-medium">{{ t("crl.unpublished") }}</p>
        <p class="text-sm text-muted-foreground">{{ t("details.crl.unpublishedBody") }}</p>
      </div>

      <Tabs v-else :key="targetId" default-value="overview" class="min-w-0">
        <TabsList class="max-w-full justify-start overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="overview">{{ t("details.tabs.overview") }}</TabsTrigger>
          <TabsTrigger value="revoked">
            {{ t("details.crl.revokedCertificates") }}
            ({{ current.tbsCertList.revokedCertificates.count }})
          </TabsTrigger>
          <TabsTrigger value="extensions">
            {{ t("details.crl.extensions") }} ({{ extensions.length }})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" :class="[PANEL, 'grid gap-6']" data-testid="crl-overview">
          <template v-if="overview">
            <section v-for="section in SECTIONS" :key="section" class="space-y-2">
              <h2 class="text-sm font-medium">{{ t(`details.crl.${section}`) }}</h2>
              <KeyValueList :items="overview[section]" />
            </section>
          </template>
          <NameDetails :name="current.tbsCertList.issuer" :title="t('details.crl.issuer')" />
        </TabsContent>
        <TabsContent value="revoked" :class="PANEL">
          <RevokedTable :revoked="current.tbsCertList.revokedCertificates" />
        </TabsContent>
        <TabsContent value="extensions" :class="PANEL">
          <!-- The extensions' accordion headings are h3. -->
          <h2 class="sr-only">{{ t("details.crl.extensions") }}</h2>
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
