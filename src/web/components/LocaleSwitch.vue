<script setup lang="ts">
import { LanguagesIcon } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { LOCALE_NAMES } from "@/i18n";
import type { AppLocale } from "@/i18n";

// Two UI languages: the switch offers the other one, named in its own language. The choice lasts
// for the page's lifetime; slice 5b adds the stored preference (`locale-preference`).
const { locale, t } = useI18n({ useScope: "global" });
const target = computed<AppLocale>(() => (locale.value === "zh-CN" ? "en" : "zh-CN"));

function switchLocale() {
  locale.value = target.value;
}
</script>

<template>
  <Button variant="ghost" size="sm" @click="switchLocale">
    <LanguagesIcon data-icon="inline-start" />
    <span class="sr-only">{{ t("locale.switchTo") }}</span>
    <span :lang="target">{{ LOCALE_NAMES[target] }}</span>
  </Button>
</template>
