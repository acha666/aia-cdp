<script setup lang="ts">
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FilePlusIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  UploadIcon,
} from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ApiError } from "@/client/errors";
import { cachedTargetLabel, useUploadCrl } from "@/client/queries";
import type { PublishedCrl } from "@/client/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCrlUploadInput } from "@/composables/useCrlUploadInput";
import { useUploadToken } from "@/composables/useUploadToken";
import { errorCode, errorMessage } from "@/utils/errors";

// Publishing a CRL from the browser (implementation slice 5b step 7), from worker-aia-cdp@5b570aa:
// src/web/components/CrlUpload.vue with its behaviour kept: no submit while the input is invalid
// or an upload runs (:22), the input cleared only if it did not change meanwhile (:28), a drop
// takes its first file (:31-48), the file input is reset after a choice (:53), the PEM hint only
// for text that is there. Files go as they are, pasted PEM as a file named crl.pem, both in the
// multipart field `crl` (M8); the server tells PEM from DER by the bytes. created, updated and
// unchanged are all successes (§10 #4); a failure shows errors.<code> as a toast and inline. The
// optional token (AIA_UPLOAD_TOKEN) stays in memory and opens itself when the server asks for it.
// Keyboard focus: the submit button is only aria-disabled while an upload runs (a disabled button
// drops the focus to <body>), and the result alert takes the focus from it afterwards (a cleared
// input disables the button).
const { t } = useI18n();
const client = useQueryClient();
const upload = useUploadCrl();
const { input, text, file, isValid, selectFile, clear } = useCrlUploadInput();
const token = useUploadToken();

const ids = { text: useId(), token: useId() };
const dragActive = ref(false);
const tokenOpen = ref(false);
// The token field gets the focus once it is rendered (the collapsible mounts it when it opens).
const tokenField = useTemplateRef<{ $el: HTMLInputElement }>("tokenField");
const focusToken = ref(false);
watchEffect(
  () => {
    if (focusToken.value && tokenField.value) {
      tokenField.value.$el.focus();
      focusToken.value = false;
    }
  },
  { flush: "post" }
);
// Set before the first await: two clicks in one tick must not both pass the guard.
const busy = ref(false);

/**
 * RFC 6750 b64token, the only form AIA_UPLOAD_TOKEN's bearerAuth accepts. Anything else cannot even
 * be sent: hono/client sets the header through Headers, which throws a TypeError on non-Latin-1
 * text ("Unexpected error (TypeError)").
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/-]+=*$/;

const submitButton = useTemplateRef<{ $el: HTMLElement }>("submitButton");
const successAlert = useTemplateRef<{ $el: HTMLElement }>("successAlert");
const failureAlert = useTemplateRef<{ $el: HTMLElement }>("failureAlert");

/** details.reason values with a message (src/core/pki/errors.ts, src/core/publish.ts). */
const REASONS: ReadonlySet<string> = new Set([
  "der",
  "trailing_bytes",
  "time",
  "structure",
  "extension_value",
  "pem_label",
  "pem_blocks",
  "pem_base64",
  "signature_algorithm_mismatch",
  "missing_aki",
]);

interface Success {
  message: string;
  published: PublishedCrl;
}
interface Failure {
  code: string;
  message: string;
  reason: string | null;
}
const success = shallowRef<Success | null>(null);
const failure = shallowRef<Failure | null>(null);

const showPemHint = computed(() => !isValid.value && text.value.trim() !== "");

/** The `details.reason` of an upload failure, as the UI language says it. */
function reasonOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) {
    return null;
  }
  const { reason } = details;
  if (typeof reason !== "string") {
    return null;
  }
  return REASONS.has(reason) ? t(`upload.reasons.${reason}`) : reason;
}

function openToken() {
  tokenOpen.value = true;
  focusToken.value = true;
}

/** The result alert takes the focus when the submit button had it (or it was already lost). */
async function focusResult(alert: typeof successAlert) {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== submitButton.value?.$el) {
    return;
  }
  await nextTick();
  alert.value?.$el.focus();
}

async function submit() {
  if (!isValid.value || busy.value) {
    return;
  }
  const bearer = token.value.trim();
  if (bearer !== "" && !TOKEN_SHAPE.test(bearer)) {
    const message = t("upload.token.invalid");
    success.value = null;
    failure.value = { code: "invalid_token", message, reason: null };
    toast.error(message);
    openToken();
    return;
  }
  busy.value = true;
  success.value = null;
  failure.value = null;
  const submitted = input.value;
  const crl =
    typeof submitted === "string"
      ? new File([submitted], "crl.pem", { type: "application/x-pem-file" })
      : submitted;
  try {
    const published = await upload.mutateAsync({ file: crl, token: bearer });
    const target =
      cachedTargetLabel(client, published.target) ?? t(`upload.kindTarget.${published.kind}`);
    const message = t(`upload.outcome.${published.outcome}`, { target });
    success.value = { message, published };
    toast.success(message);
    if (input.value === submitted) {
      clear();
    }
    void focusResult(successAlert);
  } catch (error) {
    const message = errorMessage(error, t);
    failure.value = { code: errorCode(error), message, reason: reasonOf(error) };
    toast.error(message);
    if (error instanceof ApiError && error.code === "unauthorized") {
      openToken();
    } else {
      void focusResult(failureAlert);
    }
  } finally {
    busy.value = false;
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault();
  dragActive.value = true;
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  dragActive.value = false;
  const dropped = event.dataTransfer?.files[0];
  if (dropped) {
    selectFile(dropped);
  }
}

function onFileChange(event: Event) {
  const element = event.target as HTMLInputElement;
  const chosen = element.files?.[0];
  // The same file can be chosen again after it was replaced by text.
  element.value = "";
  if (chosen) {
    selectFile(chosen);
  }
}
</script>

<template>
  <Card data-testid="upload-card">
    <CardHeader>
      <CardTitle>
        <h2>{{ t("upload.title") }}</h2>
      </CardTitle>
      <CardDescription>{{ t("upload.description") }}</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-4">
      <Alert
        v-if="success"
        ref="successAlert"
        tabindex="-1"
        class="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="upload-success"
      >
        <CircleCheckIcon class="text-success" />
        <AlertTitle>{{ success.message }}</AlertTitle>
        <AlertDescription class="grid gap-1">
          <span v-if="success.published.crlNumber !== null">
            {{ t("upload.crlNumber", { number: success.published.crlNumber }) }}
            <template v-if="success.published.baseCrlNumber !== null">
              · {{ t("upload.baseCrlNumber", { number: success.published.baseCrlNumber }) }}
            </template>
          </span>
          <span v-if="success.published.downloads.length > 0">{{ t("upload.servedAt") }}</span>
          <ul v-if="success.published.downloads.length > 0" class="grid gap-0.5">
            <li v-for="path in success.published.downloads" :key="path">
              <a :href="path" download class="font-mono text-xs break-all">{{ path }}</a>
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <Alert
        v-if="failure"
        ref="failureAlert"
        variant="destructive"
        tabindex="-1"
        class="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="upload-error"
        :data-code="failure.code"
      >
        <CircleAlertIcon />
        <AlertTitle>{{ t("upload.errors.uploadFailed") }}</AlertTitle>
        <AlertDescription>
          <p>{{ failure.message }}</p>
          <p v-if="failure.reason">{{ t("upload.reason", { reason: failure.reason }) }}</p>
        </AlertDescription>
      </Alert>

      <form class="grid gap-3" @submit.prevent="submit">
        <Label :for="ids.text">{{ t("upload.labels.pemContent") }}</Label>
        <div
          class="relative rounded-lg"
          :class="{ 'ring-3 ring-ring/50': dragActive }"
          data-testid="drop-zone"
          @dragover="onDragOver"
          @dragleave="dragActive = false"
          @drop="onDrop"
        >
          <Textarea
            :id="ids.text"
            v-model="text"
            rows="8"
            spellcheck="false"
            class="min-h-40 resize-y pb-10 font-mono text-xs"
            :placeholder="t('upload.placeholder')"
          />
          <Button
            as="label"
            variant="outline"
            size="xs"
            class="absolute right-2 bottom-2 cursor-pointer has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <FilePlusIcon data-icon="inline-start" />
            {{ t("upload.selectFile") }}
            <input
              type="file"
              accept=".crl,.pem,.der"
              class="sr-only"
              data-testid="file-input"
              @change="onFileChange"
            />
          </Button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <p v-if="showPemHint" class="text-sm text-destructive" data-testid="pem-hint">
            {{ t("upload.errors.invalidPem") }}
          </p>
          <p v-else class="text-sm text-muted-foreground" data-testid="upload-helper">
            {{ file ? file.name : t("upload.helpers.pem") }}
          </p>
          <Button
            ref="submitButton"
            type="submit"
            :disabled="!isValid"
            :aria-disabled="busy || undefined"
            class="aria-disabled:opacity-50"
            data-testid="upload-submit"
          >
            <LoaderCircleIcon
              v-if="busy"
              data-icon="inline-start"
              class="animate-spin motion-reduce:animate-none"
            />
            <UploadIcon v-else data-icon="inline-start" />
            {{ busy ? t("upload.actions.uploading") : t("upload.actions.upload") }}
          </Button>
        </div>

        <Collapsible v-model:open="tokenOpen">
          <CollapsibleTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="-ml-2 text-muted-foreground"
              data-testid="token-toggle"
            >
              <ChevronRightIcon
                data-icon="inline-start"
                class="transition-transform"
                :class="{ 'rotate-90': tokenOpen }"
              />
              <KeyRoundIcon />
              {{ t("upload.token.toggle") }}
              <span v-if="token.trim() !== ''" class="text-success">
                ({{ t("upload.token.set") }})
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent class="grid max-w-md gap-2 pt-2">
            <Label :for="ids.token">{{ t("upload.token.label") }}</Label>
            <Input
              :id="ids.token"
              ref="tokenField"
              v-model="token"
              type="password"
              autocomplete="off"
              spellcheck="false"
              data-testid="token-input"
            />
            <p class="text-xs text-muted-foreground">{{ t("upload.token.hint") }}</p>
          </CollapsibleContent>
        </Collapsible>
      </form>
    </CardContent>
  </Card>
</template>
