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
import DistributionPointList from "@/components/x509/DistributionPointList.vue";
import GeneralNameList from "@/components/x509/GeneralNameList.vue";
import TagList from "@/components/x509/TagList.vue";
import { useDateText } from "@/composables/useDateText";
import { formatDateTimeWithZone } from "@/utils/dates";
import { describeExtension, describeSubtree, oidText } from "@/utils/extension-blocks";
import type { ExtensionContext } from "@/utils/extension-blocks";
import { formatGeneralName } from "@/utils/x509";

// One extension as an accordion item (inside ExtensionList's Accordion). The header names it
// (OID beside a known name), marks it critical and, unless decoded, gives its parse status. The
// body shows the render blocks of utils/extension-blocks.ts; an extension the server could not
// decode (or of a type this build does not know) shows the parse error, the server's ASN.1 dump
// and the raw value.
const props = defineProps<{ extension: Extension; value: string }>();

const { t } = useI18n();
const dateText = useDateText();

const ctx: ExtensionContext = {
  field: (key) => t(`extension.fields.${key}`),
  nameLabel: (type) => t(`extension.generalName.${type}`),
  time: (iso) => formatDateTimeWithZone(iso, dateText),
  yesNo: (value) => t(value ? "common.yes" : "common.no"),
};

const blocks = computed(() => {
  const { parseStatus, parsed } = props.extension;
  return parseStatus === "parsed" && parsed !== undefined ? describeExtension(parsed, ctx) : null;
});
/** The header's parse status; a decoded value of a type this build cannot render is unsupported. */
const status = computed(() =>
  props.extension.parseStatus === "error" ? "error" : blocks.value ? "parsed" : "unsupported"
);
</script>

<template>
  <AccordionItem :value="value" :data-oid="extension.extnID.oid">
    <AccordionTrigger>
      <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span>{{ extension.extnID.name ?? extension.extnID.oid }}</span>
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
      <template v-if="blocks">
        <template v-for="(block, index) in blocks" :key="index">
          <KeyValueList v-if="block.kind === 'rows'" :items="block.rows" />

          <TagList v-else-if="block.kind === 'tags'" :tags="block.tags" :tone="block.tone" />

          <div v-else-if="block.kind === 'names'">
            <p v-if="block.title" class="mb-1 text-xs text-muted-foreground">{{ block.title }}</p>
            <GeneralNameList :names="block.names" />
          </div>

          <DistributionPointList v-else-if="block.kind === 'points'" :points="block.points" />

          <ul v-else-if="block.kind === 'access'" class="space-y-1 text-xs">
            <li v-for="(item, itemIndex) in block.items" :key="itemIndex" class="break-all">
              <span class="text-muted-foreground">{{
                `${item.accessMethod.name ?? item.accessMethod.oid}: `
              }}</span>
              <span class="font-mono">{{
                formatGeneralName(item.accessLocation, ctx.nameLabel)
              }}</span>
            </li>
          </ul>

          <ul v-else-if="block.kind === 'policies'" class="space-y-2 text-xs">
            <li v-for="(policy, policyIndex) in block.policies" :key="policyIndex">
              <div class="font-mono break-all">{{ oidText(policy.policyIdentifier) }}</div>
              <ul
                v-if="policy.policyQualifiers?.length"
                class="mt-1 ml-3 space-y-1 text-muted-foreground"
              >
                <li
                  v-for="(qualifier, qualifierIndex) in policy.policyQualifiers"
                  :key="qualifierIndex"
                  class="break-all"
                >
                  <template v-if="qualifier.cpsUri">
                    {{ ctx.field("cps") }}:
                    <span class="font-mono text-foreground">{{ qualifier.cpsUri }}</span>
                  </template>
                  <template v-else-if="qualifier.userNotice">
                    {{ ctx.field("userNotice") }}:
                    <span v-if="qualifier.userNotice.organization" class="text-foreground">
                      {{ qualifier.userNotice.organization }}
                      <template v-if="qualifier.userNotice.noticeNumbers?.length">
                        ({{ qualifier.userNotice.noticeNumbers.join(", ") }})
                      </template>
                    </span>
                    <span v-if="qualifier.userNotice.explicitText" class="text-foreground italic">
                      {{ qualifier.userNotice.explicitText }}
                    </span>
                  </template>
                  <template v-else>
                    {{ qualifier.qualifierId.name ?? qualifier.qualifierId.oid }}:
                    <span class="font-mono text-foreground">{{ qualifier.rawHex }}</span>
                  </template>
                </li>
              </ul>
            </li>
          </ul>

          <div v-else-if="block.kind === 'subtrees'">
            <p class="mb-1 text-xs text-muted-foreground">{{ block.title }}</p>
            <ul class="space-y-1">
              <li
                v-for="(subtree, subtreeIndex) in block.subtrees"
                :key="subtreeIndex"
                class="font-mono text-xs break-all"
              >
                {{ describeSubtree(subtree, ctx) }}
              </li>
            </ul>
          </div>
        </template>
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
              variant="grouped"
              :value="extension.extnValue.hex"
              class="mt-1 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs"
            />
          </CollapsibleContent>
        </Collapsible>
      </template>
    </AccordionContent>
  </AccordionItem>
</template>
