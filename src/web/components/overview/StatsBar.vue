<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useCrlTargets, useStats } from "@/client/queries";
import QueryError from "@/components/QueryError.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { useClock } from "@/composables/useClock";
import { computeTargetStatus, needsAttention } from "@/utils/status";

// The overview's counts (plan §8). Everything but "needs attention" comes from /api/v1/stats, which
// has no time-dependent field; that one is counted here from the target list with the page's clock
// and the badges' rule (stale, expired or unknown: owner answer 2 of slice 5b), so the number
// always matches the badges in the table below.
interface Tile {
  key: string;
  label: string;
  value: string;
  hint: string;
}

const stats = useStats();
const targets = useCrlTargets();
const now = useClock();
const { t } = useI18n();

const attention = computed(() => {
  const list = targets.data.value;
  if (list === undefined) {
    return null;
  }
  const nowMs = now.value.getTime();
  return list.filter((target) => needsAttention(computeTargetStatus(target.current, nowMs).state))
    .length;
});

const tiles = computed<Tile[] | null>(() => {
  const data = stats.data.value;
  if (data === undefined) {
    return null;
  }
  const { full, delta } = data.targets;
  return [
    {
      key: "certificates",
      label: t("stats.certificates"),
      value: String(data.certificates),
      hint: t("stats.certificatesHint"),
    },
    {
      key: "targets",
      label: t("stats.targets"),
      value: String(full + delta),
      hint: t("stats.byKind", { full, delta }),
    },
    {
      key: "published",
      label: t("stats.published"),
      value: String(data.published.full + data.published.delta),
      hint: t("stats.byKind", data.published),
    },
    {
      key: "revocations",
      label: t("stats.revocations"),
      value: data.totalRevocations === null ? t("common.unknown") : String(data.totalRevocations),
      hint: t("stats.revocationsHint"),
    },
    {
      key: "attention",
      label: t("stats.needsAttention"),
      value: attention.value === null ? "—" : String(attention.value),
      hint: t("stats.needsAttentionHint"),
    },
  ];
});
</script>

<template>
  <section :aria-label="t('stats.title')">
    <QueryError
      v-if="tiles === null && stats.isError.value"
      :error="stats.error.value"
      :title="t('stats.loadFailed')"
      @retry="stats.refetch()"
    />
    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <template v-if="tiles">
        <dl
          v-for="tile in tiles"
          :key="tile.key"
          class="rounded-xl p-3 ring-1 ring-foreground/10"
          :data-stat="tile.key"
        >
          <dt class="text-xs text-muted-foreground">{{ tile.label }}</dt>
          <dd
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="{ 'text-warning': tile.key === 'attention' && attention }"
            data-testid="stat-value"
          >
            {{ tile.value }}
          </dd>
          <dd class="mt-0.5 text-xs text-muted-foreground">{{ tile.hint }}</dd>
        </dl>
      </template>
      <template v-else>
        <div
          v-for="index in 5"
          :key="index"
          class="rounded-xl p-3 ring-1 ring-foreground/10"
          data-testid="stat-skeleton"
        >
          <Skeleton class="h-3 w-20" />
          <Skeleton class="mt-2 h-7 w-10" />
          <Skeleton class="mt-1 h-3 w-24" />
        </div>
      </template>
    </div>
  </section>
</template>
