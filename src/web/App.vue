<!-- PLACEHOLDER (slice 1 foundation): replaced by the real app shell (slice 1 step 6). -->
<script setup lang="ts">
import { Badge } from "@/components/ui/badge";

const siteName = import.meta.env.VITE_SITE_NAME;
</script>

<template>
  <main class="p-4">
    <h1 class="text-lg font-semibold">{{ siteName }}</h1>
    <Badge variant="secondary">placeholder</Badge>
  </main>
</template>
