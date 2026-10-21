<script setup lang="ts">
import type { Asn1Line } from "@/client/types";

// From worker-aia-cdp@5b570aa:src/web/components/Asn1Dump.vue: the server's generic ASN.1 dump of
// a value it could not decode, one line per element, indented two spaces per depth.
defineProps<{ lines: readonly Asn1Line[] }>();
</script>

<template>
  <ol class="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs leading-5">
    <li v-for="(line, index) in lines" :key="index" class="whitespace-pre">
      <span class="text-muted-foreground" data-testid="asn1-indent">{{
        "  ".repeat(line.depth)
      }}</span
      ><span>{{ line.tag }}</span
      ><span class="text-muted-foreground"> ({{ line.length }})</span
      ><span v-if="line.value !== undefined">{{ ` ${line.value}` }}</span>
    </li>
  </ol>
</template>
