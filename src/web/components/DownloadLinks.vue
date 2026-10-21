<script setup lang="ts">
import { computed } from "vue";
import { buttonVariants } from "@/components/ui/button";

// Download links of a certificate or CRL target, from the API's `downloads` (config paths: each DER
// path is followed by its .pem). After worker-aia-cdp@5b570aa:src/web/components/ResourceCard.vue:
// 44-51, 76-85, which derived the PEM path itself; the server's list is used as it is.
const props = defineProps<{ downloads: readonly string[] }>();

const links = computed(() =>
  props.downloads.map((href) => ({ href, format: href.endsWith(".pem") ? "PEM" : "DER" }))
);
</script>

<template>
  <span v-if="links.length > 0" class="inline-flex flex-wrap items-center gap-1">
    <a
      v-for="link in links"
      :key="link.href"
      :href="link.href"
      download
      :title="link.href"
      :data-format="link.format"
      :class="buttonVariants({ variant: 'outline', size: 'xs' })"
    >
      {{ link.format }}<span class="sr-only">: {{ link.href }}</span>
    </a>
  </span>
  <span v-else class="text-muted-foreground">—</span>
</template>
