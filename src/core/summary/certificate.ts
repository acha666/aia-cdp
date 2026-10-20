// The TBSCertificate projection of the certificate detail (implementation slice 5a step 3), built
// whole on every request (§10 #28). From worker-aia-cdp@5b570aa:src/worker/api/v2/builders/
// certificate.ts without its `options.extensions` switch (the v2 `include=` parameter is gone).
import type * as pkijs from "pkijs";
import { SIGNATURE_ALG_NAMES } from "../pki/constants.ts";
import type { TBSCertificate } from "./types.ts";
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
  const version = buildVersion(cert.version);
  const serialNumber = buildSerialNumber(cert.serialNumber);
  const signature = buildAlgorithmIdentifier(
    cert.signature.algorithmId,
    cert.signature.algorithmParams,
    SIGNATURE_ALG_NAMES
  );
  const issuer = buildName(cert.issuer);
  const subject = buildName(cert.subject);

  const validity = {
    notBefore: buildTime(cert.notBefore),
    notAfter: buildTime(cert.notAfter),
  };

  const subjectPublicKeyInfo = await buildSubjectPublicKeyInfo(cert.subjectPublicKeyInfo);
  const extensions = buildExtensions(cert.extensions);

  // PKIjs keeps the raw content octets of the implicitly tagged BIT STRINGs.
  const issuerUniqueID = cert.issuerUniqueID
    ? buildBitStringFromContent(cert.issuerUniqueID)
    : undefined;
  const subjectUniqueID = cert.subjectUniqueID
    ? buildBitStringFromContent(cert.subjectUniqueID)
    : undefined;

  return {
    version,
    serialNumber,
    signature,
    issuer,
    validity,
    subject,
    subjectPublicKeyInfo,
    issuerUniqueID,
    subjectUniqueID,
    extensions,
  };
}
