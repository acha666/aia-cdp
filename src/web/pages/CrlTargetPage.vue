<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { I18nT, useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { queries } from "@/client/queries";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import DetailLayout from "@/components/DetailLayout.vue";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ExtensionList from "@/components/x509/ExtensionList.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { useClock } from "@/composables/useClock";
import type en from "@/locales/en.json";
import { formatDate, relativeTime } from "@/utils/dates";
import { computeTargetStatus } from "@/utils/status";
import { rowOf, rows } from "@/utils/values";
import { formatAlgorithm } from "@/utils/x509";

// One CRL target (plan §8), in DetailLayout's frame: header with label, kind, status and
// downloads, then the current CRL in tabs (overview with the issuer link, CRL and base CRL numbers,
// thisUpdate / nextUpdate / Next CRL Publish, algorithm and fingerprints; revoked certificates;
// extensions). A target without a current CRL says it is not published instead, and offers no
// downloads (its paths answer 404). `targetId` matched the router's pattern. Tabs and panels as on
// CertificatePage.
const props = defineProps<{ targetId: string }>();

const i18n = useI18n();
const { t } = i18n;
const now = useClock();
const { data, error, refetch } = useQuery(() => queries.crl(props.targetId));

const current = computed(() => data.value?.current ?? null);
const status = computed(() => computeTargetStatus(current.value, now.value.getTime()));
const extensions = computed(() => current.value?.tbsCertList.crlExtensions?.items ?? []);

const time = (iso: string | null | undefined) => formatDate(iso, i18n);
const row = rowOf<keyof typeof en.details.crl>(i18n, "details.crl");

/** The overview of the current CRL, in sections; the issuer link and the status are in the header. */
const overview = computed(() => {
  const crl = current.value;
  if (crl === null) {
    return null;
  }
  const { summary } = crl;
  return {
    information: rows(
      row("crlNumber", summary.crlNumber),
      summary.baseCrlNumber !== null && row("baseCrlNumber", summary.baseCrlNumber),
      row("version", crl.tbsCertList.version.display),
      row("publishedAt", time(crl.publishedAt)),
      row("size", t("common.bytes", { count: crl.size }))
    ),
    validity: rows(
      row("thisUpdate", time(summary.thisUpdate)),
      row("nextUpdate", time(summary.nextUpdate)),
      summary.nextPublish !== null && row("nextPublish", time(summary.nextPublish))
    ),
    cryptography: [row("signatureAlgorithm", formatAlgorithm(crl.signatureAlgorithm, i18n))],
    fingerprints: [
      { label: "SHA-1", value: { hex: crl.fingerprints.sha1 } },
      { label: "SHA-256", value: { hex: crl.fingerprints.sha256 } },
    ],
  };
});

const SECTIONS = ["information", "validity", "cryptography", "fingerprints"] as const;

/**
 * Time to nextUpdate (or since it, once expired) next to the status badge; to thisUpdate while not
 * yet valid (a browser clock behind the server's), as on CertificatePage.
 */
const statusDetail = computed(() => {
  const summary = current.value?.summary;
  if (!summary || status.value === "unknown") {
    return null;
  }
  const boundary = status.value === "not-yet-valid" ? summary.thisUpdate : summary.nextUpdate;
  return relativeTime(boundary, now.value.getTime(), i18n, true);
});

const PANEL = "rounded-md pt-2 focus-visible:ring-3 focus-visible:ring-ring/50";
</script>

<template>
  <DetailLayout :id="targetId" kind="crl" :name="data?.label" :error="error" @retry="refetch()">
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
              {{ data.issuer.label ?? data.issuer.subjectCN ?? t("common.unknown") }}
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
        </TabsContent>
      </Tabs>
    </template>
  </DetailLayout>
</template>
