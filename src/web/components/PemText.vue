<script setup lang="ts">
import { CheckIcon, CopyIcon } from "@lucide/vue";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError, apiFetch } from "@/client/errors";
import QueryError from "@/components/QueryError.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopy } from "@/composables/useCopy";

// The PEM text served at one of the resource's download paths, with a copy button (the raw tab of
// a certificate, implementation slice 5b step 6). The path comes from the API's `downloads`; the
// download routes are not part of the typed client, so this is a plain GET through apiFetch (no
// response → ApiError `network`), revalidated with the route's ETag.
const props = defineProps<{ path: string }>();

const { t } = useI18n();

const pem = useQuery({
  queryKey: ["pem", () => props.path],
  queryFn: async ({ signal }) => {
    const response = await apiFetch(props.path, { cache: "no-cache", signal });
    if (!response.ok) {
      const code = response.status === 404 ? "not_found" : "invalid_response";
      throw new ApiError(response.status, code, `GET ${props.path}: ${String(response.status)}`);
    }
    return response.text();
  },
});

const { copy, copied } = useCopy();
const copyLabel = computed(() => (copied.value ? t("common.copied") : t("common.copy")));
</script>

<template>
  <QueryError
    v-if="pem.isError.value && pem.data.value === undefined"
    :error="pem.error.value"
    :title="t('details.raw.loadFailed')"
    @retry="pem.refetch()"
  />
  <Skeleton v-else-if="pem.data.value === undefined" class="h-40 w-full" />
  <div v-else class="relative">
    <Button
      type="button"
      variant="outline"
      size="xs"
      class="absolute top-2 right-2"
      :aria-label="copyLabel"
      @click="copy(pem.data.value ?? '')"
    >
      <CheckIcon v-if="copied" data-icon="inline-start" />
      <CopyIcon v-else data-icon="inline-start" />
      {{ copyLabel }}
    </Button>
    <pre
      class="max-h-[32rem] overflow-auto rounded-lg bg-muted/50 p-3 pr-24 font-mono text-xs leading-5"
      data-testid="pem-text"
      >{{ pem.data.value }}</pre>
  </div>
</template>
