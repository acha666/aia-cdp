<script setup lang="ts">
import { ArrowLeftIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/composables/usePageTitle";

const route = useRoute();
const { t } = useI18n();
usePageTitle(() => t("pages.notFound.title"));
</script>

<template>
  <section class="grid gap-4" data-testid="not-found-page">
    <h1 class="text-2xl font-semibold tracking-tight">{{ t("pages.notFound.title") }}</h1>
    <p class="max-w-prose text-muted-foreground">
      {{ t("pages.notFound.body") }}
      <code class="font-mono break-all text-foreground">{{ route.fullPath }}</code>
    </p>
    <Button as-child variant="outline" size="sm" class="w-fit">
      <RouterLink to="/">
        <ArrowLeftIcon data-icon="inline-start" />
        {{ t("nav.backToOverview") }}
      </RouterLink>
    </Button>
  </section>
</template>
