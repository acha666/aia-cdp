// Display names of certificates and CRL targets (implementation slice 5b step 6).

/** The fields a certificate's name comes from: a list item, a detail or a target's issuer. */
interface NamedCertificate {
  label: string | null;
  summary: { subjectCN: string | null };
}

/** A certificate's config label, else its subject CN; null when it has neither ("Unknown"). */
export function certificateName(certificate: NamedCertificate): string | null {
  return certificate.label ?? certificate.summary.subjectCN;
}

/** The same rule for the issuer of a CRL target (`{ id, label, subjectCN }`). */
export function issuerName(issuer: {
  label: string | null;
  subjectCN: string | null;
}): string | null {
  return issuer.label ?? issuer.subjectCN;
}

/** Display order of targets: by label, then full before delta of the same label, then by id. */
export function compareTargets(
  a: { label: string; kind: "full" | "delta"; targetId: string },
  b: { label: string; kind: "full" | "delta"; targetId: string },
  locale: string
): number {
  return (
    a.label.localeCompare(b.label, locale) ||
    (a.kind === b.kind ? 0 : a.kind === "full" ? -1 : 1) ||
    a.targetId.localeCompare(b.targetId)
  );
}
