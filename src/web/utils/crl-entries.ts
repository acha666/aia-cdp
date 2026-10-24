// The columns of a revoked-certificates row that come from its CRL entry extensions.
import type { Extension } from "@/client/types";
import type { I18nText } from "@/i18n";
import { formatDate } from "@/utils/dates";
import { formatGeneralName } from "@/utils/x509";

export interface EntryDetails {
  /** The CRLReason name (keyCompromise, ...); null without the extension. */
  reason: string | null;
  /** The invalidity date for display. */
  invalidityDate: string | null;
  /** The certificate issuer of an indirect CRL entry, its names joined with "; ". */
  issuer: string | null;
}

/** Reason, invalidity date and indirect issuer from the decoded CRL entry extensions. */
export function describeEntry(
  extensions: readonly Extension[] | undefined,
  i18n: Pick<I18nText, "locale" | "t">
): EntryDetails {
  const info: EntryDetails = { reason: null, invalidityDate: null, issuer: null };
  for (const extension of extensions ?? []) {
    const parsed = extension.parseStatus === "parsed" ? extension.parsed : undefined;
    if (parsed?.extensionType === "cRLReason") {
      info.reason = parsed.name;
    } else if (parsed?.extensionType === "invalidityDate") {
      info.invalidityDate = formatDate(parsed.date.iso, i18n);
    } else if (parsed?.extensionType === "certificateIssuer") {
      info.issuer = parsed.names.map((name) => formatGeneralName(name, i18n)).join("; ");
    }
  }
  return info;
}
