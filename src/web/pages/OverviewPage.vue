<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";

const { t } = useI18n();
</script>

<template>
  <section class="grid gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-2xl font-semibold tracking-tight">{{ t("pages.overview.title") }}</h1>
      <Badge variant="outline">{{ t("pages.placeholder") }}</Badge>
    </div>
    <p class="max-w-prose text-muted-foreground">{{ t("pages.overview.body") }}</p>
  </section>
</template>
