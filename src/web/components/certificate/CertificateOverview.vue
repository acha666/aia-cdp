<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { CertificateDetail } from "@/client/types";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import { useClock } from "@/composables/useClock";
import { useDateText } from "@/composables/useDateText";
import { formatDate, relativeTime } from "@/utils/dates";
import { compareTargets } from "@/utils/labels";
import { computeCertificateStatus } from "@/utils/status";
import { formatAlgorithm } from "@/utils/x509";

// The overview tab of a certificate: subject and issuer, validity (status with the detailed time
// to its next boundary), serial number, public key summary, the signature algorithm with its
// parameters (the detail carries every part, so nothing reads "Unknown"), the ECDSA / DSA (r, s)
// values, fingerprints, unique identifiers when present, and the CRL targets this certificate
// issues for, in the overview table's order.
const props = defineProps<{ certificate: CertificateDetail }>();

const { t, locale } = useI18n();
const now = useClock();
const dateText = useDateText();
const salt = (length: number) => t("algorithm.salt", { length });

const tbs = computed(() => props.certificate.tbsCertificate);

const validity = computed(() => {
  const { notBefore, notAfter } = tbs.value.validity;
  const nowMs = now.value.getTime();
  const state = computeCertificateStatus(notBefore.iso, notAfter.iso, nowMs);
  const boundary = state === "not-yet-valid" ? notBefore.iso : notAfter.iso;
  return {
    items: [
      {
        label: t("details.certificate.notBefore"),
        value: formatDate(notBefore.iso, dateText),
      },
      {
        label: t("details.certificate.notAfter"),
        value: formatDate(notAfter.iso, dateText),
      },
      { label: t("details.certificate.status"), value: state },
    ],
    state,
    detail: state === "unknown" ? null : relativeTime(boundary, nowMs, dateText, true),
  };
});

const general = computed(() => [
  { label: t("details.certificate.x509Version"), value: tbs.value.version.display },
  { label: t("details.certificate.serialNumber"), value: tbs.value.serialNumber.hex, hex: true },
  {
    label: t("details.certificate.imported"),
    value: formatDate(props.certificate.importedAt, dateText),
  },
  {
    label: t("details.certificate.size"),
    value: t("common.bytes", { count: props.certificate.size }),
  },
]);

/** Key type and size or curve. */
const publicKey = computed(() => {
  const spki = tbs.value.subjectPublicKeyInfo;
  const key = spki.parsed;
  const items = [
    {
      label: t("details.certificate.publicKeyAlgorithm"),
      value: formatAlgorithm(spki.algorithm, salt) ?? t("common.unknown"),
    },
  ];
  if (key.type === "rsa") {
    items.push({
      label: t("details.certificate.keySize"),
      value: `${String(key.modulus.bitLength)} ${t("common.bits")}`,
    });
  } else if (key.type === "ec") {
    items.push({ label: t("details.certificate.curve"), value: key.curve.name ?? key.curve.oid });
  }
  return [
    ...items,
    { label: t("details.certificate.publicKeySha1"), value: spki.fingerprints.sha1, hex: true },
    { label: t("details.certificate.publicKeySha256"), value: spki.fingerprints.sha256, hex: true },
  ];
});

const signature = computed(() => {
  const { signatureAlgorithm, signatureValue } = props.certificate;
  const parsed = signatureValue.parsed;
  return [
    {
      label: t("details.certificate.signatureAlgorithm"),
      value: formatAlgorithm(signatureAlgorithm, salt) ?? t("common.unknown"),
    },
    ...(parsed
      ? [
          { label: t("details.signature.r"), value: parsed.r, hex: true },
          { label: t("details.signature.s"), value: parsed.s, hex: true },
        ]
      : [{ label: t("details.signature.value"), value: signatureValue.hex, hex: true }]),
  ];
});

const fingerprints = computed(() => [
  { label: "SHA-1", value: props.certificate.fingerprints.sha1, hex: true },
  { label: "SHA-256", value: props.certificate.fingerprints.sha256, hex: true },
]);

const targets = computed(() =>
  [...props.certificate.targets].sort((a, b) => compareTargets(a, b, locale.value))
);

const uniqueIds = computed(() => [
  ...(tbs.value.issuerUniqueID
    ? [
        {
          label: t("details.certificate.issuerUniqueId"),
          value: tbs.value.issuerUniqueID.hex,
          hex: true,
        },
      ]
    : []),
  ...(tbs.value.subjectUniqueID
    ? [
        {
          label: t("details.certificate.subjectUniqueId"),
          value: tbs.value.subjectUniqueID.hex,
          hex: true,
        },
      ]
    : []),
]);
</script>

<template>
  <div class="grid gap-6">
    <div class="grid gap-6 lg:grid-cols-2">
      <NameDetails :name="tbs.subject" :title="t('details.certificate.subject')" />
      <NameDetails :name="tbs.issuer" :title="t('details.certificate.issuer')" />
    </div>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.validity") }}</h2>
      <KeyValueList :items="validity.items">
        <template #value="{ item, index }">
          <span v-if="index === 2" class="inline-flex flex-wrap items-center gap-2">
            <StatusBadge :state="validity.state" />
            <span
              v-if="validity.detail"
              class="text-muted-foreground"
              data-testid="validity-detail"
            >
              ({{ validity.detail }})
            </span>
          </span>
          <span v-else>{{ item.value }}</span>
        </template>
      </KeyValueList>
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.information") }}</h2>
      <KeyValueList :items="general" />
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.cryptography") }}</h2>
      <KeyValueList :items="publicKey" data-testid="public-key" />
      <KeyValueList :items="signature" data-testid="signature" />
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.fingerprints") }}</h2>
      <KeyValueList :items="fingerprints" />
    </section>

    <section v-if="uniqueIds.length > 0" class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.uniqueIds") }}</h2>
      <KeyValueList :items="uniqueIds" />
    </section>

    <section class="space-y-2" data-testid="crl-targets">
      <h2 class="text-sm font-medium">{{ t("details.certificate.crlTargets") }}</h2>
      <ul v-if="targets.length > 0" class="space-y-1 text-sm">
        <li v-for="target in targets" :key="target.targetId" class="flex items-center gap-2">
          <KindBadge :kind="target.kind" />
          <RouterLink
            :to="{ name: 'crl', params: { targetId: target.targetId } }"
            class="underline-offset-4 hover:underline"
          >
            {{ target.label }}
          </RouterLink>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">
        {{ t("details.certificate.noCrlTargets") }}
      </p>
    </section>
  </div>
</template>
