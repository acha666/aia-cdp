<script setup lang="ts">
import { cva } from "class-variance-authority";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import type { CertificateStatusState, CrlStatusState } from "@/utils/status";

// worker-aia-cdp@5b570aa:src/web/components/StatusBadge.vue on the shadcn Badge: one colour per
// state from theme tokens (success / warning / destructive / muted), so both themes follow, each
// at least 4.5:1 against its background (main.css, tests/web/contrast.test.ts). Unpublished has a
// dashed outline like the CRL page's "not published" box (muted text on a muted fill was 4.35:1).
type State = CertificateStatusState | CrlStatusState;

const SUCCESS = "border-transparent bg-success/10 text-success dark:bg-success/20";
const WARNING = "border-transparent bg-warning/10 text-warning dark:bg-warning/20";
const DESTRUCTIVE = "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20";

const statusVariants = cva("", {
  variants: {
    state: {
      valid: SUCCESS,
      current: SUCCESS,
      expiring: WARNING,
      stale: WARNING,
      "not-yet-valid": WARNING,
      expired: DESTRUCTIVE,
      unknown: "text-muted-foreground",
      unpublished: "border-dashed text-muted-foreground",
    } satisfies Record<State, string>,
  },
});

const LABEL_KEYS = {
  valid: "status.valid",
  expiring: "status.expiring",
  expired: "status.expired",
  "not-yet-valid": "status.notYetValid",
  current: "status.current",
  stale: "status.stale",
  unknown: "common.unknown",
  unpublished: "crl.unpublished",
} satisfies Record<State, string>;

defineProps<{ state: State }>();

const { t } = useI18n();
</script>

<template>
  <Badge variant="outline" :data-state="state" :class="statusVariants({ state })">
    {{ t(LABEL_KEYS[state]) }}
  </Badge>
</template>
