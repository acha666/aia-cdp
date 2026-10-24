<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useCrlTargets } from "@/client/queries";
import DownloadLinks from "@/components/DownloadLinks.vue";
import KindBadge from "@/components/KindBadge.vue";
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
import { formatDate, relativeTime } from "@/utils/dates";
import { compareTargets, issuerName } from "@/utils/labels";
import { computeTargetStatus } from "@/utils/status";

// The configured CRL targets (plan §8), one table for full and delta targets: label with the
// issuer, kind, CRL number, thisUpdate / nextUpdate (time left only while current), revoked count,
// status and downloads. A target without a current CRL reads "Not published" with dashes, never 0,
// and has no downloads (its paths answer 404). On a phone (below sm) only label, kind and status
// show, as in CertificateTable.
const { data, isPending, isError, error, refetch } = useCrlTargets();

const SECONDARY = "hidden sm:table-cell";
/** The cell classes of a skeleton row, column by column. */
const SKELETON = ["", "", SECONDARY, SECONDARY, SECONDARY, "", SECONDARY];
const now = useClock();
const i18n = useI18n();
const { t, locale } = i18n;

const rows = computed(() => {
  const nowMs = now.value.getTime();
  return [...(data.value ?? [])]
    .sort((a, b) => compareTargets(a, b, locale.value))
    .map((target) => {
      const state = computeTargetStatus(target.current, nowMs);
      const summary = target.current?.summary ?? null;
      return {
        targetId: target.targetId,
        label: target.label,
        kind: target.kind,
        issuer: issuerName(target.issuer) ?? t("common.unknown"),
        crlNumber: summary?.crlNumber ?? null,
        thisUpdate: summary
          ? formatDate(summary.thisUpdate, i18n, { time: false, zone: false })
          : null,
        nextUpdate: summary ? formatDate(summary.nextUpdate, i18n, { time: false }) : null,
        remaining: state === "current" ? relativeTime(summary?.nextUpdate, nowMs, i18n) : null,
        revoked: summary === null ? null : String(summary.revokedCount),
        state,
        downloads: target.current === null ? [] : target.downloads,
      };
    });
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{{ t("app.sections.crls") }}</h2>
      </CardTitle>
      <CardDescription v-if="data">
        {{ t("common.itemCount", { count: data.length }, data.length) }}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <QueryError
        v-if="isError && !data"
        :error="error"
        :title="t('overview.crlsFailed')"
        @retry="refetch()"
      />
      <Table v-else data-testid="crl-target-table">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t("table.label") }}</TableHead>
            <TableHead>{{ t("table.kind") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.crlNumber") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.updates") }}</TableHead>
            <TableHead :class="SECONDARY" class="text-right">{{ t("table.revoked") }}</TableHead>
            <TableHead>{{ t("table.status") }}</TableHead>
            <TableHead :class="SECONDARY">{{ t("table.downloads") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="isPending">
            <TableRow v-for="index in 3" :key="index" data-testid="skeleton-row">
              <TableCell v-for="(cellClass, cell) in SKELETON" :key="cell" :class="cellClass">
                <Skeleton class="h-4 w-16" />
              </TableCell>
            </TableRow>
          </template>
          <TableEmpty v-else-if="rows.length === 0" :colspan="7">
            {{ t("app.empty.crls") }}
          </TableEmpty>
          <TableRow v-for="row in rows" v-else :key="row.targetId" :data-id="row.targetId">
            <TableCell class="whitespace-normal sm:min-w-44">
              <RouterLink
                :to="{ name: 'crl', params: { targetId: row.targetId } }"
                class="font-medium underline-offset-4 hover:underline"
              >
                {{ row.label }}
              </RouterLink>
              <div class="text-xs text-muted-foreground">{{ row.issuer }}</div>
            </TableCell>
            <TableCell><KindBadge :kind="row.kind" /></TableCell>
            <TableCell :class="SECONDARY" class="font-mono text-xs" data-testid="crl-number">
              {{ row.crlNumber === null ? "—" : `#${row.crlNumber}` }}
            </TableCell>
            <TableCell :class="SECONDARY" class="text-xs">
              <template v-if="row.thisUpdate">
                <div>{{ row.thisUpdate }} – {{ row.nextUpdate }}</div>
                <div v-if="row.remaining" class="text-muted-foreground" data-testid="remaining">
                  {{ row.remaining }}
                </div>
              </template>
              <span v-else class="text-muted-foreground">—</span>
            </TableCell>
            <TableCell
              :class="SECONDARY"
              class="text-right tabular-nums"
              data-testid="revoked-count"
            >
              {{ row.revoked ?? "—" }}
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
