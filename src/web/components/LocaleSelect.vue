<script setup lang="ts">
import { LanguagesIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useLocale } from "@/composables/useLocale";
import { LOCALE_NAMES, SUPPORTED_LOCALES } from "@/i18n";

// The UI language, as a native select (two entries, each named in its own language); useLocale
// remembers the choice (locale-preference).
const locale = useLocale();
const { t } = useI18n();
</script>

<template>
  <label class="relative inline-flex items-center">
    <LanguagesIcon class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
    <span class="sr-only">{{ t("common.language") }}</span>
    <select
      v-model="locale"
      class="h-7 rounded-md border border-input bg-transparent pr-1 pl-7 text-[0.8rem] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:scheme-dark"
    >
      <option v-for="code in SUPPORTED_LOCALES" :key="code" :value="code" :lang="code">
        {{ LOCALE_NAMES[code] }}
      </option>
    </select>
  </label>
</template>
