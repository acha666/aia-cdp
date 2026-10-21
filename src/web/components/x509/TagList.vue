<script setup lang="ts">
import { cva } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";
import type { TagTone } from "@/utils/extension-blocks";

// The tag blocks of an extension and the reasons of a distribution point. The old TAG_TONES
// (worker-aia-cdp@5b570aa:src/web/components/ExtensionView.vue:277-281) as Badge variants with
// theme tokens only: flags (blue) filled, purposes and scopes (purple) outlined, reasons (amber)
// in the warning colour. Tones only tell lists apart within one extension, so the neutral pair
// is enough there.
const tagVariants = cva("font-normal", {
  variants: {
    tone: {
      blue: "border-transparent bg-secondary text-secondary-foreground",
      purple: "text-foreground",
      amber: "border-transparent bg-warning/10 text-warning dark:bg-warning/20",
    } satisfies Record<TagTone, string>,
  },
});

defineProps<{ tags: readonly string[]; tone: TagTone }>();
</script>

<template>
  <ul class="flex flex-wrap gap-1">
    <li v-for="(tag, index) in tags" :key="index">
      <Badge variant="outline" :data-tone="tone" :class="tagVariants({ tone })">{{ tag }}</Badge>
    </li>
  </ul>
</template>
