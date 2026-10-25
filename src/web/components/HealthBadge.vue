<script setup lang="ts">
import {
  CircleCheckIcon,
  CircleQuestionMarkIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "@lucide/vue";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import type { Component } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/client/api";
import { Badge } from "@/components/ui/badge";
import type { BadgeVariants } from "@/components/ui/badge";

// 200 → healthy / degraded, 503 → unhealthy, both with the same body. Anything else (network
// error, a proxy's 502, a body that is not JSON) rejects, and the badge shows "unknown".
async function fetchHealth() {
  const response = await api.api.v1.health.$get();
  const { status } = response;
  if (status !== 200 && status !== 503) {
    throw new Error(`Unexpected health response status ${String(status)}`);
  }
  return response.json();
}

type BadgeState = "loading" | "healthy" | "degraded" | "unhealthy" | "unknown";

const APPEARANCE = {
  loading: { variant: "outline", icon: LoaderCircleIcon },
  healthy: { variant: "secondary", icon: CircleCheckIcon },
  degraded: { variant: "outline", icon: TriangleAlertIcon },
  unhealthy: { variant: "destructive", icon: CircleXIcon },
  unknown: { variant: "outline", icon: CircleQuestionMarkIcon },
} satisfies Record<BadgeState, { variant: BadgeVariants["variant"]; icon: Component }>;

const { t } = useI18n();
// retry: false — the badge reports the current state. TanStack's default (3 retries with 1 + 2 + 4 s
// backoff) kept an unreachable API on "Checking…" for ~7 s; a transient failure clears on the
// next mount or window focus (staleTime 0, main.ts).
const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, retry: false });

const state = computed<BadgeState>(() =>
  health.isError.value ? "unknown" : (health.data.value?.status ?? "loading")
);
const appearance = computed(() => APPEARANCE[state.value]);
// Degraded means the configuration is missing or invalid, and the detail says which.
const detail = computed(() => {
  const key = state.value === "degraded" ? health.data.value?.checks.configuration : state.value;
  return t(`health.detail.${key ?? "unknown"}`);
});
</script>

<template>
  <Badge role="status" :variant="appearance.variant" :data-state="state" :title="detail">
    <component
      :is="appearance.icon"
      data-icon="inline-start"
      :class="{ 'animate-spin motion-reduce:animate-none': state === 'loading' }"
    />
    <span class="sr-only">{{ t("health.label") }}</span>
    <span data-testid="health-state">{{ t(`health.state.${state}`) }}</span>
  </Badge>
</template>
