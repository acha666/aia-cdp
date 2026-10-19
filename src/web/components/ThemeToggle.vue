<script setup lang="ts">
import { MonitorIcon, MoonIcon, SunIcon } from "@lucide/vue";
import { useColorMode } from "@vueuse/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

type Preference = "auto" | "light" | "dark";

// Same localStorage key and values as the old implementation's useTheme.ts, so a preference saved
// on the same origin keeps applying. useColorMode sets class "dark" / "light" on <html> (main.css:
// `@custom-variant dark (&:is(.dark *))`). Destructure `store`: the returned ref is auto-unwrapped
// in templates, so `mode.store` would not be reachable there.
const { store } = useColorMode({ storageKey: "theme-preference" });

// Same cycle as before: auto → light → dark.
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
