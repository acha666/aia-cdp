<script setup lang="ts">
import { MonitorIcon, MoonIcon, SunIcon } from "@lucide/vue";
import { useColorMode, useStorage } from "@vueuse/core";
import type { BasicColorSchema } from "@vueuse/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

type Preference = "auto" | "light" | "dark";

// The preference (auto / light / dark) is kept in localStorage. useColorMode sets class "dark" /
// "light" on <html> (main.css: `@custom-variant dark (&:is(.dark *))`); the inline script in
// index.html sets "dark" by the same rule before the first paint. disableTransition would insert a
// <style> element on every change, which a CSP without 'unsafe-inline' styles blocks. The stored
// preference is our own useStorage ref because useColorMode does not pass `onError` on: blocked
// storage only loses the memory and is not worth a console error.
const store = useStorage<BasicColorSchema>("theme-preference", "auto", undefined, {
  onError: () => undefined,
});
useColorMode({ storageRef: store, disableTransition: false });

// Each click moves on: auto → light → dark → auto.
const NEXT: Record<Preference, Preference> = { auto: "light", light: "dark", dark: "auto" };
const ICONS = { auto: MonitorIcon, light: SunIcon, dark: MoonIcon };

const { t } = useI18n();
// A foreign value in storage behaves as "auto" until the next click replaces it.
const current = computed<Preference>(() =>
  Object.hasOwn(NEXT, store.value) ? store.value : "auto"
);
const label = computed(() =>
  t("theme.toggle", {
    current: t(`theme.mode.${current.value}`),
    next: t(`theme.mode.${NEXT[current.value]}`),
  })
);

function cycle() {
  store.value = NEXT[current.value];
}
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    :aria-label="label"
    :title="label"
    :data-preference="current"
    @click="cycle"
  >
    <component :is="ICONS[current]" />
  </Button>
</template>
