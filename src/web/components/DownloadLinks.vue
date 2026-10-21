<script setup lang="ts">
import { computed } from "vue";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Download links of a certificate or CRL target, from the API's `downloads` (config paths: each DER
// path is followed by its .pem). After worker-aia-cdp@5b570aa:src/web/components/ResourceCard.vue:
// 44-51, 76-85, which derived the PEM path itself; the server's list is used as it is. A resource
// served at more than one DER path also shows each file name, so the pairs can be told apart.
// Through cn like Button.vue: the variant's border-border then replaces the base's
// border-transparent, which otherwise wins in the generated CSS (no outline in the light theme).
const props = defineProps<{ downloads: readonly string[] }>();

const CLASS = cn(buttonVariants({ variant: "outline", size: "xs" }));

const links = computed(() => {
  const named = props.downloads.filter((href) => !href.endsWith(".pem")).length > 1;
  return props.downloads.map((href) => ({
    href,
    format: href.endsWith(".pem") ? "PEM" : "DER",
    fileName: named ? href.slice(href.lastIndexOf("/") + 1) : null,
  }));
});
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
      :class="CLASS"
    >
      <!-- Flex items: the button's gap separates them, without whitespace in the name. -->
      {{ link.format
      }}<span
        v-if="link.fileName"
        class="font-mono font-normal text-muted-foreground"
        data-testid="file-name"
        >{{ link.fileName }}</span
      ><span class="sr-only">: {{ link.href }}</span>
    </a>
  </span>
  <span v-else class="text-muted-foreground">—</span>
</template>
