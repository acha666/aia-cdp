// The TBSCertList projection of the CRL detail, built whole on every request: every revoked entry
// is returned (no pages and no cursor), and there is no CRL type here, since the kind of a target
// comes from config.json, not from the presence of a Delta CRL Indicator.
import type * as pkijs from "pkijs";
import { SIGNATURE_ALG_NAMES } from "../pki/constants.ts";
import type { TBSCertList, RevokedCertificate } from "./types.ts";
import {
  buildVersion,
  buildSerialNumber,
  buildAlgorithmIdentifier,
  buildTime,
  buildName,
} from "./primitives.ts";
import { buildExtensions, buildExtension } from "./extensions.ts";

export function buildTBSCertList(crl: pkijs.CertificateRevocationList): TBSCertList {
  const version = buildVersion(crl.version);

  const signature = buildAlgorithmIdentifier(
    crl.signature.algorithmId,
    crl.signature.algorithmParams,
    SIGNATURE_ALG_NAMES
  );
  const issuer = buildName(crl.issuer);
  const thisUpdate = buildTime(crl.thisUpdate);
  const nextUpdate = crl.nextUpdate ? buildTime(crl.nextUpdate) : undefined;

  // Every revoked entry; an absent list is an empty one.
  const items = (crl.revokedCertificates ?? []).map(buildRevokedCertificate);
  const revokedCertificates = { count: items.length, items };

  // Build CRL extensions
  const crlExtensions = buildExtensions(crl.crlExtensions?.extensions);

  return {
    version,
    signature,
    issuer,
    thisUpdate,
    nextUpdate,
    revokedCertificates,
    crlExtensions,
  };
}

function buildRevokedCertificate(revoked: pkijs.RevokedCertificate): RevokedCertificate {
  const userCertificate = buildSerialNumber(revoked.userCertificate);
  const revocationDate = buildTime(revoked.revocationDate);

  let crlEntryExtensions: RevokedCertificate["crlEntryExtensions"];
  if (revoked.crlEntryExtensions?.extensions && revoked.crlEntryExtensions.extensions.length > 0) {
    const items = revoked.crlEntryExtensions.extensions.map(buildExtension);
    crlEntryExtensions = {
      count: items.length,
      items,
    };
  }

  return {
    userCertificate,
    revocationDate,
    crlEntryExtensions,
  };
}
