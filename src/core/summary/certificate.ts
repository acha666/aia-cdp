// The TBSCertificate projection of the certificate detail, built whole on every request.
import type * as pkijs from "pkijs";
import { SIGNATURE_ALG_NAMES } from "../pki/constants.ts";
import type { TBSCertificate } from "./schemas.ts";
import {
  buildVersion,
  buildSerialNumber,
  buildAlgorithmIdentifier,
  buildBitStringFromContent,
  buildTime,
  buildName,
  buildSubjectPublicKeyInfo,
} from "./primitives.ts";
import { buildExtensions } from "./extensions.ts";

export async function buildTBSCertificate(cert: pkijs.Certificate): Promise<TBSCertificate> {
  return {
    version: buildVersion(cert.version),
    serialNumber: buildSerialNumber(cert.serialNumber),
    signature: buildAlgorithmIdentifier(cert.signature, SIGNATURE_ALG_NAMES),
    issuer: buildName(cert.issuer),
    validity: { notBefore: buildTime(cert.notBefore), notAfter: buildTime(cert.notAfter) },
    subject: buildName(cert.subject),
    subjectPublicKeyInfo: await buildSubjectPublicKeyInfo(cert.subjectPublicKeyInfo),
    // PKIjs keeps the raw content octets of the implicitly tagged BIT STRINGs.
    issuerUniqueID: cert.issuerUniqueID && buildBitStringFromContent(cert.issuerUniqueID),
    subjectUniqueID: cert.subjectUniqueID && buildBitStringFromContent(cert.subjectUniqueID),
    extensions: buildExtensions(cert.extensions),
  };
}
