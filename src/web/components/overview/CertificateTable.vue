<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useCertificates } from "@/client/queries";
import DownloadLinks from "@/components/DownloadLinks.vue";
import QueryError from "@/components/QueryError.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useClock } from "@/composables/useClock";
import { useDateText } from "@/composables/useDateText";
import { formatDateDay, formatDateDayWithoutTimezone, getRelativeTime } from "@/utils/dates";
import { certificateName } from "@/utils/labels";
import { computeCertificateStatus } from "@/utils/status";

// The imported certificates (plan §8): name (config label, else subject CN), issuer, validity with
// the time left while valid, status and downloads, sorted by name. The list keeps showing while it
// refetches; skeleton rows appear only before the first answer. On a phone (below sm) only the name
// and the status show: with every column the table scrolls sideways inside its card, which hides
// the status; issuer, validity and downloads are on the detail page. From sm up, where the table
// may still scroll, the name keeps a minimum width instead of one word per line.
const { data, isPending, isError, error, refetch } = useCertificates();

const SECONDARY = "hidden sm:table-cell";
/** The cell classes of a skeleton row, column by column. */
const SKELETON = ["", SECONDARY, SECONDARY, "", SECONDARY];
const now = useClock();
const dateText = useDateText();
const { t, locale } = useI18n();

const rows = computed(() => {
  const nowMs = now.value.getTime();
  return (data.value ?? [])
    .map((certificate) => {
      const { notBefore, notAfter, issuerCN, subjectCN } = certificate.summary;
      const status = computeCertificateStatus(notBefore, notAfter, nowMs);
      const name = certificateName(certificate);
      return {
        id: certificate.id,
        name: name ?? t("details.certificate.unknownName"),
        // The CN under a label, when they differ.
        subjectCN: certificate.label !== null && subjectCN !== certificate.label ? subjectCN : null,
        issuer: issuerCN ?? t("common.unknown"),
        from: formatDateDayWithoutTimezone(notBefore, dateText),
        until: formatDateDay(notAfter, dateText),
        // Only while the certificate is valid (expiring is the last tenth of that).
        remaining:
          status.state === "valid" || status.state === "expiring"
            ? getRelativeTime(notAfter, nowMs, dateText)
            : null,
        state: status.state,
        downloads: certificate.downloads,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale.value) || a.id.localeCompare(b.id));
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{{ t("app.sections.certificates") }}</h2>
      </CardTitle>
      <CardDescription v-if="data">
        {{ t("common.itemCount", { count: data.length }, data.length) }}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <QueryError
        v-if="isError && !data"
        :error="error"
        :title="t('overview.certificatesFailed')"
        @retry="refetch()"
      />
      <Table v-else data-testid="certificate-table">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t("table.name") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.issuer") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.validity") }}</TableHead>
            <TableHead>{{ t("table.status") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.downloads") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="isPending">
            <TableRow v-for="index in 3" :key="index" data-testid="skeleton-row">
              <TableCell v-for="(cellClass, cell) in SKELETON" :key="cell" :class="cellClass">
                <Skeleton class="h-4 w-24" />
              </TableCell>
            </TableRow>
          </template>
          <TableEmpty v-else-if="rows.length === 0" :colspan="5">
            {{ t("app.empty.certificates") }}
          </TableEmpty>
          <TableRow v-for="row in rows" v-else :key="row.id" :data-id="row.id">
            <TableCell class="whitespace-normal sm:min-w-44">
              <RouterLink
                :to="{ name: 'certificate', params: { id: row.id } }"
                class="font-medium underline-offset-4 hover:underline"
              >
                {{ row.name }}
              </RouterLink>
              <div v-if="row.subjectCN" class="text-xs text-muted-foreground">
                {{ row.subjectCN }}
              </div>
            </TableCell>
            <TableCell
              :class="SECONDARY"
              class="min-w-40 whitespace-normal text-muted-foreground"
              >{{ row.issuer }}</TableCell
            >
            <TableCell :class="SECONDARY" class="text-xs">
              <div>{{ row.from }} – {{ row.until }}</div>
              <div v-if="row.remaining" class="text-muted-foreground" data-testid="remaining">
                {{ row.remaining }}
              </div>
            </TableCell>
            <TableCell><StatusBadge :state="row.state" /></TableCell>
            <TableCell :class="[SECONDARY, { 'text-center': row.downloads.length === 0 }]">
              <DownloadLinks :downloads="row.downloads" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
