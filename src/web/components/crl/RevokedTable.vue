<script setup lang="ts">
import { ChevronLeftIcon, ChevronRightIcon } from "@lucide/vue";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { GeneralName, RevokedCertificates } from "@/client/types";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDateText } from "@/composables/useDateText";
import { describeEntry } from "@/utils/crl-entries";
import { formatDateTimeWithZone } from "@/utils/dates";

// The revoked certificates of a target's current CRL (plan §8): serial number, revocation date,
// reason, invalidity date and indirect issuer. `null` is a target without a current CRL: no list at
// all, never 0; an empty list says so. The API sends every entry (a 10 000-entry CRL is 5.5 MB of
// JSON), so the table renders PAGE_SIZE rows at a time; the header row stays in view while the box
// scrolls. The first and the last page disable one page button: the other one takes its focus.
const props = defineProps<{ revoked: RevokedCertificates | null }>();

const PAGE_SIZE = 200;

const { t } = useI18n();
const dateText = useDateText();
const page = ref(0);

// A refetch with other entries starts over on the first page.
watch(
  () => props.revoked,
  () => {
    page.value = 0;
  }
);

const total = computed(() => props.revoked?.items.length ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const first = computed(() => page.value * PAGE_SIZE);
const last = computed(() => Math.min(first.value + PAGE_SIZE, total.value));

const previousButton = useTemplateRef<{ $el: HTMLElement }>("previousButton");
const nextButton = useTemplateRef<{ $el: HTMLElement }>("nextButton");

async function turn(delta: 1 | -1) {
  const pressed = (delta < 0 ? previousButton : nextButton).value?.$el;
  const hadFocus = pressed !== undefined && document.activeElement === pressed;
  page.value += delta;
  // A disabled button drops the focus to <body>.
  if (hadFocus && (page.value === 0 || page.value === pageCount.value - 1)) {
    await nextTick();
    (delta < 0 ? nextButton : previousButton).value?.$el.focus();
  }
}

const entryContext = {
  nameLabel: (type: GeneralName["type"]) => t(`extension.generalName.${type}`),
  time: (iso: string) => formatDateTimeWithZone(iso, dateText),
};

/** Only the rows of the current page are formatted. */
const rows = computed(() =>
  (props.revoked?.items ?? []).slice(first.value, last.value).map((entry, index) => ({
    key: first.value + index,
    serial: entry.userCertificate.hex,
    revoked: formatDateTimeWithZone(entry.revocationDate.iso, dateText),
    ...describeEntry(entry.crlEntryExtensions?.items, entryContext),
  }))
);
</script>

<template>
  <p
    v-if="revoked === null"
    class="text-sm text-muted-foreground"
    data-testid="revoked-unpublished"
  >
    {{ t("crl.unpublished") }}
  </p>
  <p v-else-if="total === 0" class="text-sm text-muted-foreground" data-testid="revoked-empty">
    {{ t("details.crl.noRevoked") }}
  </p>
  <div v-else class="grid gap-2">
    <div class="max-h-[36rem] overflow-auto rounded-lg border">
      <table data-slot="table" class="w-full caption-bottom text-sm" data-testid="revoked-table">
        <TableHeader class="sticky top-0 z-10 bg-muted">
          <TableRow class="hover:bg-transparent">
            <TableHead>{{ t("details.crl.serialNumber") }}</TableHead>
            <TableHead>{{ t("details.crl.revocationDate") }}</TableHead>
            <TableHead>{{ t("details.crl.reason") }}</TableHead>
            <TableHead>{{ t("details.crl.invalidSince") }}</TableHead>
            <TableHead>{{ t("details.crl.certificateIssuer") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in rows" :key="row.key">
            <TableCell class="font-mono text-xs break-all whitespace-normal">{{
              row.serial
            }}</TableCell>
            <TableCell class="text-xs">{{ row.revoked }}</TableCell>
            <TableCell class="text-xs">{{ row.reason ?? "—" }}</TableCell>
            <TableCell class="text-xs">{{ row.invalidityDate ?? "—" }}</TableCell>
            <TableCell class="font-mono text-xs break-all whitespace-normal">
              {{ row.issuer ?? "—" }}
            </TableCell>
          </TableRow>
        </TableBody>
      </table>
    </div>
    <div
      v-if="pageCount > 1"
      class="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground"
    >
      <span data-testid="revoked-range">
        {{ t("details.crl.range", { from: first + 1, to: last, total }) }}
      </span>
      <Button
        ref="previousButton"
        variant="outline"
        size="icon-xs"
        :disabled="page === 0"
        :aria-label="t('common.previousPage')"
        data-testid="previous-page"
        @click="turn(-1)"
      >
        <ChevronLeftIcon />
      </Button>
      <Button
        ref="nextButton"
        variant="outline"
        size="icon-xs"
        :disabled="page >= pageCount - 1"
        :aria-label="t('common.nextPage')"
        data-testid="next-page"
        @click="turn(1)"
      >
        <ChevronRightIcon />
      </Button>
    </div>
  </div>
</template>
