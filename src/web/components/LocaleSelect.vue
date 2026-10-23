<script setup lang="ts">
import { LanguagesIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useLocale } from "@/composables/useLocale";
import { LOCALE_NAMES, SUPPORTED_LOCALES } from "@/i18n";

// The UI language, as a plain native select in the footer (two entries, each named in its own
// language); useLocale remembers the choice (locale-preference). The options carry the popover
// colours: Chrome and Firefox on Windows draw the open list with them, and a transparent select
// would otherwise leave light text on a white list in the dark theme.
const locale = useLocale();
const { t } = useI18n();
</script>

<template>
  <label class="relative inline-flex items-center hover:text-foreground">
    <LanguagesIcon class="pointer-events-none absolute left-1 size-3.5" />
    <span class="sr-only">{{ t("common.language") }}</span>
    <select
      v-model="locale"
      class="h-6 cursor-pointer rounded-sm bg-transparent pr-1 pl-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <option
        v-for="code in SUPPORTED_LOCALES"
        :key="code"
        :value="code"
        :lang="code"
        class="bg-popover text-popover-foreground"
      >
        {{ LOCALE_NAMES[code] }}
      </option>
    </select>
  </label>
</template>
