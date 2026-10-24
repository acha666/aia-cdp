// The TBSCertList projection of the CRL detail, built whole on every request: every revoked entry
// is returned (no pages and no cursor), and there is no CRL type here, since the kind of a target
// comes from config.json, not from the presence of a Delta CRL Indicator.
import type * as pkijs from "pkijs";
import { SIGNATURE_ALG_NAMES } from "../pki/constants.ts";
import type { TBSCertList, RevokedCertificate } from "./schemas.ts";
import {
  buildVersion,
  buildSerialNumber,
  buildAlgorithmIdentifier,
  buildTime,
} from "./primitives.ts";
import { buildName } from "./names.ts";
import { buildExtensions, buildExtension } from "./extensions.ts";

export function buildTBSCertList(crl: pkijs.CertificateRevocationList): TBSCertList {
  // An absent list is an empty one.
  const items = (crl.revokedCertificates ?? []).map(buildRevokedCertificate);
  return {
    version: buildVersion(crl.version),
    signature: buildAlgorithmIdentifier(crl.signature, SIGNATURE_ALG_NAMES),
    issuer: buildName(crl.issuer),
    thisUpdate: buildTime(crl.thisUpdate),
    nextUpdate: crl.nextUpdate && buildTime(crl.nextUpdate),
    revokedCertificates: { count: items.length, items },
    crlExtensions: buildExtensions(crl.crlExtensions?.extensions),
  };
}

function buildRevokedCertificate(revoked: pkijs.RevokedCertificate): RevokedCertificate {
  const extensions = revoked.crlEntryExtensions?.extensions;
  return {
    userCertificate: buildSerialNumber(revoked.userCertificate),
    revocationDate: buildTime(revoked.revocationDate),
    crlEntryExtensions: extensions?.length
      ? { count: extensions.length, items: extensions.map(buildExtension) }
      : undefined,
  };
}
