<script setup lang="ts">
import { ChevronRightIcon } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Extension } from "@/client/types";
import HexValue from "@/components/HexValue.vue";
import KeyValueList from "@/components/KeyValueList.vue";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import Asn1Dump from "@/components/x509/Asn1Dump.vue";
import { useExtensionContext } from "@/composables/useExtensionContext";
import { describeExtension } from "@/utils/extension-display";

// One extension as an accordion item (inside ExtensionList's Accordion). The header names it
// (OID beside a known name, on its baseline; hover underlines the name only), marks it critical
// and, unless decoded, gives its parse status. The body shows the sections of
// utils/extension-display.ts, each one KeyValueList, a rule between them. An extension the server
// could not decode (or of a type this build does not know) shows the parse error, the server's
// ASN.1 dump and the raw value.
const props = defineProps<{ extension: Extension; value: string }>();

const { t } = useI18n();
const ctx = useExtensionContext();

const sections = computed(() => {
  const { parseStatus, parsed } = props.extension;
  return parseStatus === "parsed" && parsed !== undefined ? describeExtension(parsed, ctx) : null;
});
/** The header's parse status; a decoded value of a type this build cannot render is unsupported. */
const status = computed(() =>
  props.extension.parseStatus === "error" ? "error" : sections.value ? "parsed" : "unsupported"
);
</script>

<template>
  <AccordionItem :value="value" :data-oid="extension.extnID.oid">
    <AccordionTrigger class="hover:no-underline">
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="underline-offset-4 group-hover/accordion-trigger:underline">
          {{ extension.extnID.name ?? extension.extnID.oid }}
        </span>
        <span
          v-if="extension.extnID.name"
          class="font-mono text-xs font-normal text-muted-foreground"
        >
          {{ extension.extnID.oid }}
        </span>
        <Badge v-if="extension.critical" variant="destructive" data-testid="critical">
          {{ t("extension.critical") }}
        </Badge>
        <Badge
          v-if="status !== 'parsed'"
          :variant="status === 'error' ? 'destructive' : 'outline'"
          data-testid="parse-status"
        >
          {{ t(`extension.status.${status}`) }}
        </Badge>
      </span>
    </AccordionTrigger>
    <AccordionContent class="space-y-3">
      <template v-if="sections">
        <p v-if="sections.length === 0" class="text-sm text-muted-foreground">
          {{ t("common.emptyValue") }}
        </p>
        <KeyValueList
          v-for="(section, index) in sections"
          :key="index"
          :items="section"
          :class="{ 'border-t pt-3': index > 0 }"
        />
      </template>

      <template v-else>
        <p v-if="extension.parseError" class="text-xs text-destructive" data-testid="parse-error">
          {{ t("extension.error") }}: {{ extension.parseError }}
        </p>
        <div v-if="extension.asn1?.length">
          <p class="mb-1 text-xs text-muted-foreground">{{ t("extension.asn1") }}</p>
          <Asn1Dump :lines="extension.asn1" />
        </div>
        <Collapsible v-slot="{ open }">
          <CollapsibleTrigger as-child>
            <Button variant="ghost" size="xs" class="-ml-2 text-muted-foreground">
              <ChevronRightIcon
                data-icon="inline-start"
                class="transition-transform"
                :class="{ 'rotate-90': open }"
              />
              {{ t("extension.rawHex") }}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <HexValue
              block
              :value="extension.extnValue.hex"
              class="mt-1 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs"
            />
          </CollapsibleContent>
        </Collapsible>
      </template>
    </AccordionContent>
  </AccordionItem>
</template>
