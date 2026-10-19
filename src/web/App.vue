<script setup lang="ts">
import { watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, RouterView } from "vue-router";
import HealthBadge from "@/components/HealthBadge.vue";
import LocaleSwitch from "@/components/LocaleSwitch.vue";
import ThemeToggle from "@/components/ThemeToggle.vue";
import { siteName } from "@/site";

const { locale, t } = useI18n();

// <html lang> follows the UI language (screen readers, hyphenation, CJK font selection).
watchEffect(() => {
  document.documentElement.lang = locale.value;
});
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <a
      href="#main"
      class="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-3 focus:ring-ring/50"
    >
      {{ t("app.skipToContent") }}
    </a>
    <header class="border-b">
      <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
        <RouterLink to="/" class="mr-auto min-w-0 truncate rounded-sm font-semibold">
          {{ siteName }}
        </RouterLink>
        <HealthBadge />
        <LocaleSwitch />
        <ThemeToggle />
      </div>
    </header>
    <main id="main" tabindex="-1" class="mx-auto w-full max-w-5xl flex-1 px-4 py-8 outline-none">
      <RouterView />
    </main>
  </div>
</template>
