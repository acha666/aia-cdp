// The columns of a revoked-certificates row that come from its CRL entry extensions.
import type { Extension } from "@/client/types";
import type { ExtensionContext } from "@/utils/extension-display";

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
  ctx: Pick<ExtensionContext, "name" | "time">
): EntryDetails {
  const info: EntryDetails = { reason: null, invalidityDate: null, issuer: null };
  for (const extension of extensions ?? []) {
    const parsed = extension.parseStatus === "parsed" ? extension.parsed : undefined;
    if (parsed?.extensionType === "cRLReason") {
      info.reason = parsed.name;
    } else if (parsed?.extensionType === "invalidityDate") {
      info.invalidityDate = ctx.time(parsed.date.iso);
    } else if (parsed?.extensionType === "certificateIssuer") {
      info.issuer = parsed.names.map(ctx.name).join("; ");
    }
  }
  return info;
}
