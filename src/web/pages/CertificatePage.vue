<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

defineProps<{ id: string }>();

const { t } = useI18n();
</script>

<template>
  <section class="grid gap-4">
    <Button as-child variant="ghost" size="sm" class="w-fit">
      <RouterLink to="/">
        <ArrowLeftIcon data-icon="inline-start" />
        {{ t("nav.backToOverview") }}
      </RouterLink>
    </Button>
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-2xl font-semibold tracking-tight">{{ t("pages.certificate.title") }}</h1>
      <Badge variant="outline">{{ t("pages.placeholder") }}</Badge>
    </div>
    <dl class="grid gap-1 text-sm">
      <dt class="text-muted-foreground">{{ t("pages.certificate.idLabel") }}</dt>
      <dd>
        <code class="font-mono break-all" data-testid="route-param">{{ id }}</code>
      </dd>
    </dl>
    <p class="max-w-prose text-muted-foreground">{{ t("pages.certificate.body") }}</p>
  </section>
</template>
