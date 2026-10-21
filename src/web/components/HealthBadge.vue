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
import { queryKeys } from "@/client/queries";
import { Badge } from "@/components/ui/badge";
import type { BadgeVariants } from "@/components/ui/badge";

interface Health {
  status: "healthy" | "degraded" | "unhealthy";
  configuration: "ok" | "missing" | "invalid" | "unknown";
}

// 200 → healthy / degraded, 503 → unhealthy. Anything else (network error, a proxy's 502, a body
// that is not the health JSON) rejects, and the badge shows "unknown".
async function fetchHealth(): Promise<Health> {
  const response = await api.api.v1.health.$get();
  const { status } = response;
  if (response.status === 503) {
    return { status: "unhealthy", configuration: "unknown" };
  }
  if (response.status === 200) {
    const body = await response.json();
    if (body.status !== "healthy" && body.status !== "degraded") {
      throw new Error("Unexpected health response body");
    }
    return { status: body.status, configuration: body.checks.configuration };
  }
  throw new Error(`Unexpected health response status ${String(status)}`);
}

type BadgeState = Health["status"] | "loading" | "unknown";

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
const health = useQuery({ queryKey: queryKeys.health, queryFn: fetchHealth, retry: false });

const state = computed<BadgeState>(() => {
  if (health.isError.value) {
    return "unknown";
  }
  return health.data.value?.status ?? "loading";
});
const appearance = computed(() => APPEARANCE[state.value]);
const detail = computed(() => {
  const configuration = health.data.value?.configuration;
  if (state.value === "degraded" && (configuration === "missing" || configuration === "invalid")) {
    return t(`health.detail.${configuration}`);
  }
  return t(`health.detail.${state.value}`);
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
