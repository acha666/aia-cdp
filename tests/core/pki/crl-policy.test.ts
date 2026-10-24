import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_ISSUER_OID,
  checkCrlPolicy,
  checkEntryPolicy,
  ISSUING_DISTRIBUTION_POINT_OID,
} from "../../../src/core/pki/crl-policy.ts";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import type { ReceivedCrl } from "../../../src/core/pki/parsers.ts";
import { cert, crlEntry, fixture, NOW } from "../../fixtures/pki.ts";
import { extension } from "../../helpers/pki.ts";

// checkCrlPolicy and checkEntryPolicy. Fixtures cover what `openssl ca` can produce; the other
// shapes are made by changing the parsed PKIjs object, which is fine because the policy does not
// check the signature.

const FULL_01 = "crls/issuing-ca-1/full-01.der";
/** A private OID (IANA example enterprise number). */
const UNKNOWN = "1.3.6.1.4.1.32473.99";

const crlOf = (file: string) => parseCRL(fixture(file));
const at = (iso: string, deltaMs = 0) => new Date(Date.parse(iso) + deltaMs);
const OK = { ok: true, expired: false };

/** `crl` with `added` appended to its CRL extensions. */
function withCrlExtension(crl: ReceivedCrl, added: pkijs.Extension) {
  crl.crlExtensions = new pkijs.Extensions({
    extensions: [...(crl.crlExtensions?.extensions ?? []), added],
  });
  return crl;
}

/** full-01 with `added` appended to the extensions of its one entry (leaf-revoked). */
function withEntryExtension(added: pkijs.Extension) {
  const crl = crlOf(FULL_01);
  const revoked = crl.revokedCertificates![0]!;
  revoked.crlEntryExtensions = new pkijs.Extensions({
    extensions: [...(revoked.crlEntryExtensions?.extensions ?? []), added],
  });
  return crl;
}

describe("checkCrlPolicy", () => {
  it("accepts thisUpdate exactly five minutes ahead and rejects one ms more", () => {
    const { thisUpdate } = crlEntry(FULL_01);
    expect(checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -5 * 60_000))).toEqual(OK);
    expect(checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -5 * 60_000 - 1))).toEqual({
      ok: false,
      error: "not_yet_valid",
      details: { thisUpdate: new Date(thisUpdate).toISOString() },
      detail: expect.any(String) as unknown,
    });
  });

  it("accepts a CRL past its nextUpdate as expired, and one without nextUpdate never", () => {
    const { nextUpdate } = crlEntry(FULL_01);
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!))).toEqual(OK);
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!, 1))).toEqual({ ok: true, expired: true });
    const crl = crlOf("crls/issuing-ca-1/full-no-next-update.der");
    expect(checkCrlPolicy(crl, new Date("2099-01-01T00:00:00Z"))).toEqual(OK);
  });

  // A CA may mark them critical; none is critical in the fixtures.
  it("accepts every recognized extension marked critical", () => {
    const crl = crlOf("crls/issuing-ca-1/full-adcs.der");
    // Issuer Alternative Name and Authority Information Access: the policy does not read them.
    for (const oid of ["2.5.29.18", "1.3.6.1.5.5.7.1.1"]) {
      withCrlExtension(crl, extension(oid, new asn1.Sequence()));
    }
    for (const ext of crl.crlExtensions!.extensions) {
      ext.critical = true;
    }
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
  });

  // publishCrl's rejections cover the critical one.
  it("accepts an unknown extension that is not critical", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-unknown-noncritical.der"), NOW)).toEqual(
      OK
    );
  });

  // A partition is never the issuer's whole CRL, so the scope is refused also when the IDP is not
  // marked critical (against RFC 5280, which requires it to be). publishCrl's rejections cover a
  // critical one.
  it("accepts an IDP naming only the distribution point and refuses any other field", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-idp-dp-only.der"), NOW)).toEqual(OK);
    // onlyContainsCACerts [2] TRUE, not critical.
    const caCerts = new asn1.Sequence({
      value: [
        new asn1.Primitive({
          idBlock: { tagClass: 3, tagNumber: 2 },
          valueHex: Uint8Array.of(0xff).buffer,
        }),
      ],
    });
    const crl = withCrlExtension(
      crlOf(FULL_01),
      extension(ISSUING_DISTRIBUTION_POINT_OID, caCerts)
    );
    expect(checkCrlPolicy(crl, NOW)).toMatchObject({ ok: false, error: "scoped_crl_unsupported" });
    const notSequence = extension(ISSUING_DISTRIBUTION_POINT_OID, new asn1.Integer({ value: 1 }));
    expect(checkCrlPolicy(withCrlExtension(crlOf(FULL_01), notSequence), NOW)).toMatchObject({
      ok: false,
      error: "invalid_crl",
      details: { reason: "extension_value" },
    });
  });
});

describe("checkEntryPolicy", () => {
  const value = new asn1.Utf8String({ value: "x" });

  it("accepts reasonCode, invalidityDate and holdInstructionCode marked critical", () => {
    const crl = crlOf(FULL_01);
    const extensions = crl.revokedCertificates![0]!.crlEntryExtensions!.extensions;
    const hold = new asn1.ObjectIdentifier({ value: "1.2.840.10040.2.3" });
    extensions.push(extension("2.5.29.23", hold));
    for (const ext of extensions) {
      ext.critical = true;
    }
    expect(checkEntryPolicy(crl)).toEqual({ ok: true });
  });

  it("rejects an unknown critical entry extension with the oid and the entry's serial", () => {
    expect(checkEntryPolicy(withEntryExtension(extension(UNKNOWN, value, true)))).toEqual({
      ok: false,
      error: "unknown_critical_extension",
      details: { oid: UNKNOWN, serialNumber: cert("leaf-revoked").serial },
      detail: expect.any(String) as unknown,
    });
    expect(checkEntryPolicy(withEntryExtension(extension(UNKNOWN, value)))).toEqual({ ok: true });
  });

  it("rejects a certificateIssuer entry (an indirect CRL), also when not critical", () => {
    const names = new pkijs.GeneralNames({
      names: [new pkijs.GeneralName({ type: 6, value: "http://other.example.test/" })],
    });
    const crl = withEntryExtension(extension(CERTIFICATE_ISSUER_OID, names.toSchema()));
    expect(checkEntryPolicy(crl)).toMatchObject({
      ok: false,
      error: "scoped_crl_unsupported",
      details: { oid: CERTIFICATE_ISSUER_OID, serialNumber: cert("leaf-revoked").serial },
    });
  });
});
