<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { CertificateDetail } from "@/client/types";
import KeyValueList from "@/components/KeyValueList.vue";
import KindBadge from "@/components/KindBadge.vue";
import NameDetails from "@/components/x509/NameDetails.vue";
import type en from "@/locales/en.json";
import { formatDate } from "@/utils/dates";
import { compareTargets } from "@/utils/labels";
import { rowOf, rows } from "@/utils/values";
import { formatAlgorithm } from "@/utils/x509";

// The overview tab of a certificate: subject and issuer, validity (the status is in the page
// header), serial number, public key summary, the signature algorithm with its parameters, the
// ECDSA / DSA (r, s) values, fingerprints, unique identifiers when present, and the CRL targets
// this certificate issues for, in the overview table's order.
const props = defineProps<{ certificate: CertificateDetail }>();

const i18n = useI18n();
const { t, locale } = i18n;
const row = rowOf<keyof typeof en.details.certificate>(i18n, "details.certificate");
const sig = rowOf<keyof typeof en.details.signature>(i18n, "details.signature");

const tbs = computed(() => props.certificate.tbsCertificate);

const validity = computed(() => {
  const { notBefore, notAfter } = tbs.value.validity;
  return [
    row("notBefore", formatDate(notBefore.iso, i18n)),
    row("notAfter", formatDate(notAfter.iso, i18n)),
  ];
});

const general = computed(() => [
  row("x509Version", tbs.value.version.display),
  row("serialNumber", { hex: tbs.value.serialNumber.hex }),
  row("imported", formatDate(props.certificate.importedAt, i18n)),
  row("size", t("common.bytes", { count: props.certificate.size })),
]);

/** Key type and size or curve. */
const publicKey = computed(() => {
  const spki = tbs.value.subjectPublicKeyInfo;
  const key = spki.parsed;
  return rows(
    row("publicKeyAlgorithm", formatAlgorithm(spki.algorithm, i18n)),
    key.type === "rsa" && row("keySize", `${String(key.modulus.bitLength)} ${t("common.bits")}`),
    key.type === "ec" && row("curve", key.curve.name ?? key.curve.oid),
    row("publicKeySha1", { hex: spki.fingerprints.sha1 }),
    row("publicKeySha256", { hex: spki.fingerprints.sha256 })
  );
});

const signature = computed(() => {
  const { signatureAlgorithm, signatureValue } = props.certificate;
  const parsed = signatureValue.parsed;
  return [
    row("signatureAlgorithm", formatAlgorithm(signatureAlgorithm, i18n)),
    ...(parsed
      ? [sig("r", { hex: parsed.r }), sig("s", { hex: parsed.s })]
      : [sig("value", { hex: signatureValue.hex })]),
  ];
});

const fingerprints = computed(() => [
  { label: "SHA-1", value: { hex: props.certificate.fingerprints.sha1 } },
  { label: "SHA-256", value: { hex: props.certificate.fingerprints.sha256 } },
]);

const targets = computed(() =>
  [...props.certificate.targets].sort((a, b) => compareTargets(a, b, locale.value))
);

const uniqueIds = computed(() => {
  const { issuerUniqueID, subjectUniqueID } = tbs.value;
  return rows(
    issuerUniqueID !== undefined && row("issuerUniqueId", { hex: issuerUniqueID.hex }),
    subjectUniqueID !== undefined && row("subjectUniqueId", { hex: subjectUniqueID.hex })
  );
});
</script>

<template>
  <div class="grid gap-6">
    <div class="grid gap-6 lg:grid-cols-2">
      <NameDetails :name="tbs.subject" :title="t('details.certificate.subject')" />
      <NameDetails :name="tbs.issuer" :title="t('details.certificate.issuer')" />
    </div>

    <section class="space-y-2">
      <h2 class="text-sm font-medium">{{ t("details.certificate.validity") }}</h2>
      <KeyValueList :items="validity" />
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
