import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_ISSUER_OID,
  checkCrlPolicy,
  checkEntryPolicy,
  ISSUING_DISTRIBUTION_POINT_OID,
  MAX_CLOCK_SKEW_MS,
} from "../../../src/core/pki/crl-policy.ts";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import type { ReceivedCrl } from "../../../src/core/pki/parsers.ts";
import { fixture, manifest, NOW } from "../../fixtures/pki.ts";
import type { ManifestCrl } from "../../fixtures/pki.ts";
import { cert } from "../../helpers/catalog.ts";
import { extension, padOid } from "../../helpers/pki.ts";

// checkCrlPolicy (slice 4 step 3; C2, M11, M13, M14, §10 #12, owner answers 2 and 5). Fixtures
// cover what `openssl ca` can produce; entry extension criticality is made by changing the parsed
// PKIjs object, and an outer / inner algorithm mismatch by changing the received AlgorithmIdentifier
// octets that parseCRL exposes, which is fine because the policy runs before the signature check.

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const ADCS = "crls/issuing-ca-1/full-adcs.der";
/** The private OID of full-unknown-critical (appendix D, IANA example enterprise number). */
const UNKNOWN_CRITICAL = "1.3.6.1.4.1.32473.1";
const UNKNOWN = "1.3.6.1.4.1.32473.99";

function entry(file: string): ManifestCrl {
  const found = manifest.crls.find((crl) => crl.file === file);
  if (!found) {
    throw new Error(`no manifest entry for ${file}`);
  }
  return found;
}

const crlOf = (file: string) => parseCRL(fixture(file));
const at = (iso: string, deltaMs = 0) => new Date(Date.parse(iso) + deltaMs);

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
  const [revoked] = crl.revokedCertificates ?? [];
  if (!revoked) {
    throw new Error("full-01 has no entry");
  }
  revoked.crlEntryExtensions = new pkijs.Extensions({
    extensions: [...(revoked.crlEntryExtensions?.extensions ?? []), added],
  });
  return crl;
}

/** An IssuingDistributionPoint with the given context fields (0 = a fullName URI). */
function idp(...fields: number[]): asn1.Sequence {
  const uri = new asn1.Primitive({
    idBlock: { tagClass: 3, tagNumber: 6 },
    valueHex: new TextEncoder().encode("http://pki.example.test/crl/issuing-ca-1.crl").buffer,
  });
  const context = (tagNumber: number, value: asn1.BaseBlock[]) =>
    new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value });
  return new asn1.Sequence({
    value: fields.map((tagNumber) =>
      tagNumber === 0
        ? context(0, [context(0, [uri])])
        : new asn1.Primitive({
            idBlock: { tagClass: 3, tagNumber },
            // onlySomeReasons [3] is a BIT STRING (keyCompromise), the others BOOLEAN TRUE.
            valueHex: (tagNumber === 3 ? Uint8Array.of(0x06, 0x40) : Uint8Array.of(0xff)).buffer,
          })
    ),
  });
}

const OK = { ok: true, expired: false };

describe("checkCrlPolicy on the fixtures", () => {
  const policyCodes = ["unknown_critical_extension", "scoped_crl_unsupported", "not_yet_valid"];

  // Every parsable fixture at manifest.now: the policy's share of the first-upload outcome.
  it.each(
    manifest.crls
      .filter((crl) => crl.expect !== "invalid_crl")
      .map((crl) => [crl.file, crl] as const)
  )("%s: as its manifest expect says", (file, crl) => {
    const result = checkCrlPolicy(crlOf(file), NOW);
    if (policyCodes.includes(crl.expect)) {
      expect(result).toMatchObject({ ok: false, error: crl.expect });
    } else {
      expect(result).toMatchObject({ ok: true });
    }
  });

  it("rejects full-unknown-critical with the extension's oid", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-unknown-critical.der"), NOW)).toEqual({
      ok: false,
      error: "unknown_critical_extension",
      details: { oid: UNKNOWN_CRITICAL },
      detail: expect.any(String) as unknown,
    });
  });

  it("accepts full-unknown-noncritical", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-unknown-noncritical.der"), NOW)).toEqual(
      OK
    );
  });

  it("rejects full-idp-scoped (critical IDP, onlyContainsUserCerts)", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-idp-scoped.der"), NOW)).toMatchObject({
      ok: false,
      error: "scoped_crl_unsupported",
      details: { oid: ISSUING_DISTRIBUTION_POINT_OID },
    });
  });

  it("accepts full-idp-dp-only: a critical IDP naming only the distribution point (owner answer 2)", () => {
    const crl = crlOf("crls/issuing-ca-1/full-idp-dp-only.der");
    const idpExtension = crl.crlExtensions?.extensions.find(
      (ext) => ext.extnID === ISSUING_DISTRIBUTION_POINT_OID
    );
    expect(idpExtension?.critical).toBe(true);
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
  });

  it("rejects full-future as not_yet_valid with its thisUpdate", () => {
    const file = "crls/issuing-ca-1/full-future.der";
    expect(checkCrlPolicy(crlOf(file), NOW)).toEqual({
      ok: false,
      error: "not_yet_valid",
      details: { thisUpdate: new Date(entry(file).thisUpdate).toISOString() },
      detail: expect.any(String) as unknown,
    });
  });

  it("accepts the reason code and invalidity date of full-01 and the hold instruction of issuing-ca-2", () => {
    for (const [file, oids] of [
      [FULL_01, ["2.5.29.21", "2.5.29.24"]],
      ["crls/issuing-ca-2/full-01.der", ["2.5.29.21", "2.5.29.23"]],
    ] as const) {
      const crl = crlOf(file);
      const seen = (crl.revokedCertificates ?? []).flatMap(
        (revoked) => revoked.crlEntryExtensions?.extensions.map((ext) => ext.extnID) ?? []
      );
      expect(seen, file).toEqual(expect.arrayContaining([...oids]));
      expect(checkEntryPolicy(crl), file).toEqual({ ok: true });
    }
  });
});

describe("clock", () => {
  const { thisUpdate, nextUpdate } = entry(FULL_01);

  it("accepts thisUpdate exactly five minutes ahead and rejects one second (or one ms) more", () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
    expect(checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -MAX_CLOCK_SKEW_MS))).toEqual(OK);
    for (const late of [1000, 1]) {
      expect(
        checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -MAX_CLOCK_SKEW_MS - late))
      ).toMatchObject({ ok: false, error: "not_yet_valid" });
    }
  });

  it("accepts an expired CRL and says so (delta-01 at manifest.now)", () => {
    const file = "crls/issuing-ca-1/delta-01.der";
    expect(Date.parse(entry(file).nextUpdate ?? "")).toBeLessThan(NOW.getTime());
    expect(checkCrlPolicy(crlOf(file), NOW)).toEqual({ ok: true, expired: true });
  });

  it("is not expired at nextUpdate itself, and is one ms later", () => {
    expect(nextUpdate).not.toBeNull();
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!))).toEqual(OK);
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!, 1))).toEqual({ ok: true, expired: true });
  });

  it("never expires a CRL without nextUpdate", () => {
    const crl = crlOf("crls/issuing-ca-1/full-no-next-update.der");
    expect(crl.nextUpdate).toBeUndefined();
    expect(checkCrlPolicy(crl, new Date("2099-01-01T00:00:00Z"))).toEqual(OK);
  });
});

describe("CRL extensions", () => {
  // M14: recognition does not depend on criticality.
  it("accepts a critical CRL Number", () => {
    const crl = crlOf(FULL_01);
    const number = crl.crlExtensions?.extensions.find((ext) => ext.extnID === "2.5.29.20");
    expect(number).toBeDefined();
    number!.critical = true;
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
  });

  // C2: none of these is critical in the fixtures; the live old code answered invalid_signature
  // for a critical AD CS extension.
  it.each([
    ["CA Version", "1.3.6.1.4.1.311.21.1"],
    ["Next CRL Publish", "1.3.6.1.4.1.311.21.4"],
    ["CRL Self CDP", "1.3.6.1.4.1.311.21.14"],
    ["Freshest CRL", "2.5.29.46"],
    ["Authority Key Identifier", "2.5.29.35"],
  ])("accepts full-adcs with its %s marked critical", (_name, oid) => {
    const crl = crlOf(ADCS);
    const target = crl.crlExtensions?.extensions.find((ext) => ext.extnID === oid);
    expect(target?.critical).toBe(false);
    target!.critical = true;
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
  });

  const uri = (value: string) => new pkijs.GeneralName({ type: 6, value });
  it.each([
    [
      "Issuer Alternative Name",
      "2.5.29.18",
      new pkijs.AltName({ altNames: [uri("http://pki.example.test/")] }).toSchema(),
    ],
    [
      "Authority Information Access",
      "1.3.6.1.5.5.7.1.1",
      new pkijs.InfoAccess({
        accessDescriptions: [
          new pkijs.AccessDescription({
            accessMethod: "1.3.6.1.5.5.7.48.2",
            accessLocation: uri("http://pki.example.test/ca/issuing-ca-1.crt"),
          }),
        ],
      }).toSchema(),
    ],
  ])("accepts a critical %s", (_name, oid, value) => {
    expect(checkCrlPolicy(withCrlExtension(crlOf(ADCS), extension(oid, value, true)), NOW)).toEqual(
      OK
    );
  });

  it("rejects any other critical extension and keeps a non-critical one", () => {
    const value = new asn1.Utf8String({ value: "x" });
    expect(
      checkCrlPolicy(withCrlExtension(crlOf(ADCS), extension(UNKNOWN, value, true)), NOW)
    ).toMatchObject({ ok: false, error: "unknown_critical_extension", details: { oid: UNKNOWN } });
    expect(checkCrlPolicy(withCrlExtension(crlOf(ADCS), extension(UNKNOWN, value)), NOW)).toEqual(
      OK
    );
  });

  describe("Issuing Distribution Point", () => {
    const check = (value: asn1.BaseBlock, critical: boolean) =>
      checkCrlPolicy(
        withCrlExtension(
          crlOf(FULL_01),
          extension(ISSUING_DISTRIBUTION_POINT_OID, value, critical)
        ),
        NOW
      );

    it.each([true, false])("accepts only a distributionPoint (critical: %s)", (critical) => {
      expect(check(idp(0), critical)).toEqual(OK);
    });

    // Not RFC 5280 (an IDP must be critical), but a partition is never the issuer's whole CRL.
    it.each([
      ["onlyContainsUserCerts", [0, 1]],
      ["onlyContainsCACerts", [2]],
      ["onlySomeReasons", [0, 3]],
      ["indirectCRL", [0, 4]],
      ["onlyContainsAttributeCerts", [5]],
    ])("rejects %s as scoped_crl_unsupported, critical or not", (_field, fields) => {
      for (const critical of [true, false]) {
        expect(check(idp(...fields), critical), String(critical)).toMatchObject({
          ok: false,
          error: "scoped_crl_unsupported",
          details: { oid: ISSUING_DISTRIBUTION_POINT_OID },
        });
      }
    });

    it("rejects an IDP that is not a SEQUENCE as invalid_crl / extension_value", () => {
      for (const critical of [true, false]) {
        expect(check(new asn1.Integer({ value: 1 }), critical), String(critical)).toMatchObject({
          ok: false,
          error: "invalid_crl",
          details: { reason: "extension_value" },
        });
      }
    });
  });
});

describe("entry extensions", () => {
  const serial = () => cert("leaf-revoked").serial;
  const value = new asn1.Utf8String({ value: "x" });

  it("rejects an unknown critical entry extension with the oid and the entry's serial", () => {
    expect(checkEntryPolicy(withEntryExtension(extension(UNKNOWN, value, true)))).toEqual({
      ok: false,
      error: "unknown_critical_extension",
      details: { oid: UNKNOWN, serialNumber: serial() },
      detail: expect.any(String) as unknown,
    });
    expect(checkEntryPolicy(withEntryExtension(extension(UNKNOWN, value)))).toEqual({ ok: true });
  });

  it.each([true, false])(
    "rejects a certificateIssuer entry (indirect CRL), critical: %s",
    (critical) => {
      const names = new pkijs.GeneralNames({
        names: [new pkijs.GeneralName({ type: 6, value: "http://other.example.test/" })],
      });
      const crl = withEntryExtension(extension(CERTIFICATE_ISSUER_OID, names.toSchema(), critical));
      expect(checkEntryPolicy(crl)).toMatchObject({
        ok: false,
        error: "scoped_crl_unsupported",
        details: { oid: CERTIFICATE_ISSUER_OID, serialNumber: serial() },
      });
    }
  );

  it("accepts reasonCode, invalidityDate and holdInstructionCode marked critical", () => {
    const crl = crlOf(FULL_01);
    for (const ext of crl.revokedCertificates?.[0]?.crlEntryExtensions?.extensions ?? []) {
      ext.critical = true;
    }
    const hold = new asn1.ObjectIdentifier({ value: "1.2.840.10040.2.3" });
    const [revoked] = crl.revokedCertificates ?? [];
    revoked!.crlEntryExtensions!.extensions.push(extension("2.5.29.23", hold, true));
    expect(revoked!.crlEntryExtensions!.extensions.every((ext) => ext.critical)).toBe(true);
    expect(checkEntryPolicy(crl)).toEqual({ ok: true });
  });
});

describe("signature algorithm (M11, owner answer 5)", () => {
  const mismatch = {
    ok: false,
    error: "invalid_crl",
    details: { reason: "signature_algorithm_mismatch" },
  };

  /** The DER of an AlgorithmIdentifier, as an AlgorithmIdentifier field of an upload would hold. */
  const algorithmDer = (algorithmId: string, algorithmParams?: asn1.BaseBlock) =>
    new Uint8Array(
      new pkijs.AlgorithmIdentifier({
        algorithmId,
        ...(algorithmParams === undefined ? {} : { algorithmParams }),
      })
        .toSchema()
        .toBER(false)
    );

  it("rejects an outer signatureAlgorithm with another OID", () => {
    const crl = crlOf(FULL_01);
    crl.signatureAlgorithmView = algorithmDer("1.2.840.113549.1.1.12", new asn1.Null());
    expect(checkCrlPolicy(crl, NOW)).toMatchObject(mismatch);
  });

  it("rejects the same OID with other parameters (NULL against absent), on either side", () => {
    for (const side of ["signatureAlgorithmView", "signatureView"] as const) {
      const crl = crlOf(FULL_01);
      expect(crl.signatureAlgorithm.algorithmParams).toBeInstanceOf(asn1.Null);
      crl[side] = algorithmDer(crl.signature.algorithmId);
      expect(checkCrlPolicy(crl, NOW), side).toMatchObject(mismatch);
    }
  });

  it("compares the RSASSA-PSS parameters too", () => {
    const crl = crlOf("crls/issuing-ca-1/full-pss.der");
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
    const params = new pkijs.RSASSAPSSParams({ schema: crl.signatureAlgorithm.algorithmParams });
    params.saltLength = 20;
    crl.signatureAlgorithmView = algorithmDer(
      crl.signatureAlgorithm.algorithmId,
      params.toSchema()
    );
    expect(checkCrlPolicy(crl, NOW)).toMatchObject(mismatch);
  });

  // C2 of the slice 4 review: asn1js decodes an OID subidentifier padded with 0x80 as the same OID
  // and re-encodes it canonically, so a comparison of re-encodings took the two as equal.
  it("compares the octets as received, not their re-encodings", () => {
    const crl = crlOf(FULL_01);
    crl.signatureAlgorithmView = padOid(crl.signatureAlgorithmView);
    const reencoded = (algorithm: pkijs.AlgorithmIdentifier) =>
      new Uint8Array(algorithm.toSchema().toBER(false));
    const decoded = new pkijs.AlgorithmIdentifier({
      schema: asn1.fromBER(crl.signatureAlgorithmView).result,
    });
    expect(reencoded(decoded)).toEqual(reencoded(crl.signature));
    expect(checkCrlPolicy(crl, NOW)).toMatchObject(mismatch);
  });
});

describe("order: the first violation wins", () => {
  it("checks the algorithms before the clock", () => {
    const crl = crlOf("crls/issuing-ca-1/full-future.der");
    crl.signatureView = padOid(crl.signatureView);
    expect(checkCrlPolicy(crl, NOW)).toMatchObject({ error: "invalid_crl" });
  });

  it("checks the clock before the extensions", () => {
    const crl = withCrlExtension(
      crlOf("crls/issuing-ca-1/full-future.der"),
      extension(UNKNOWN, new asn1.Null(), true)
    );
    expect(checkCrlPolicy(crl, NOW)).toMatchObject({ error: "not_yet_valid" });
  });

  it("checks the CRL extensions in their order", () => {
    const crl = crlOf(FULL_01);
    withCrlExtension(crl, extension(ISSUING_DISTRIBUTION_POINT_OID, idp(0, 1), true));
    withCrlExtension(crl, extension(UNKNOWN, new asn1.Null(), true));
    expect(checkCrlPolicy(crl, NOW)).toMatchObject({
      error: "scoped_crl_unsupported",
      details: { oid: ISSUING_DISTRIBUTION_POINT_OID },
    });
  });
});
