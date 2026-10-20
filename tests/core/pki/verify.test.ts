import type { webcrypto } from "node:crypto";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNATURE_ALG_NAMES } from "../../../src/core/pki/constants.ts";
import { parseCertificate, parseCRL } from "../../../src/core/pki/parsers.ts";
import { verifyCrlSignature } from "../../../src/core/pki/verify.ts";
import { fixture, manifest } from "../../fixtures/pki.ts";
import { cert } from "../../helpers/catalog.ts";

// verifyCrlSignature (slice 4 step 4; B21, C1, C2, C4, M10, M12, owner answer 1). The C1 / C2 /
// EdDSA cases double as probes for a PKIjs upgrade (risks of slice 4): they show that the check
// does not go through PKIjs's own CRL verification, which compares issuer names and refuses
// critical extensions it does not know. The allow-list cases sign with keys made here, since the
// fixtures cannot cover every algorithm (no P-521 CA, no ECDSA with SHA-1 or SHA-512).

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";
const MGF1 = "1.2.840.113549.1.1.8";

const crlOf = (file: string) => parseCRL(fixture(file));

/** The DER of `crl` around its tbsView (PKIjs types toSchema() as any). */
const derOf = (crl: pkijs.CertificateRevocationList) =>
  new Uint8Array((crl.toSchema() as asn1.Sequence).toBER(false));

/** The TBSCertList encoded afresh from the decoded fields. */
const encodedTbs = (crl: pkijs.CertificateRevocationList) =>
  new Uint8Array(
    ((crl.toSchema(true) as asn1.Sequence).valueBlock.value[0] as asn1.Sequence).toBER(false)
  );
const certificateOf = (name: string) => parseCertificate(fixture(cert(name).der));
const spkiOf = (name: string) => certificateOf(name).subjectPublicKeyInfo;
const engine = pkijs.getCrypto(true);

/** Records whether the cryptography ran (it must not for a refused algorithm or key). */
const cryptoSpy = () => vi.spyOn(engine, "verifyWithPublicKey");

afterEach(() => {
  vi.restoreAllMocks();
});

/** A copy of `spki` with another algorithm identifier (the key bits are kept). */
function withKeyAlgorithm(spki: pkijs.PublicKeyInfo, algorithmId: string, params?: asn1.BaseBlock) {
  return new pkijs.PublicKeyInfo({
    algorithm: new pkijs.AlgorithmIdentifier({
      algorithmId,
      ...(params === undefined ? {} : { algorithmParams: params }),
    }),
    subjectPublicKey: spki.subjectPublicKey,
  });
}

const algorithmId = (id: string, params?: asn1.BaseBlock) =>
  new pkijs.AlgorithmIdentifier({
    algorithmId: id,
    ...(params === undefined ? {} : { algorithmParams: params }),
  });

describe("verifyCrlSignature on the fixtures", () => {
  // Every parsable fixture against the CA of its directory (full-forged-aki: issuing-ca-1, whose
  // name and AKI it carries).
  it.each(
    manifest.crls
      .filter((crl) => crl.expect !== "invalid_crl")
      .map((crl) => [crl.file, crl] as const)
  )("%s", async (file, crl) => {
    const result = await verifyCrlSignature(crlOf(file), spkiOf(crl.issuer));
    if (crl.expect === "invalid_signature" || crl.expect === "unsupported_algorithm") {
      expect(result).toMatchObject({ ok: false, reason: crl.expect });
    } else {
      expect(result).toEqual({ ok: true });
    }
  });

  it.each([
    ["RSA, SHA-256", FULL_01],
    ["RSASSA-PSS", "crls/issuing-ca-1/full-pss.der"],
    ["ECDSA P-384", ROOT_FULL_01],
    ["RSA, SHA-1 (owner answer 1)", "crls/issuing-ca-1/full-sha1.der"],
  ])("verifies %s", async (_case, file) => {
    const crl = manifest.crls.find((entry) => entry.file === file)!;
    expect(await verifyCrlSignature(crlOf(file), spkiOf(crl.issuer))).toEqual({ ok: true });
  });

  it.each([
    ["full-broken-sig (last byte flipped)", "crls/issuing-ca-1/full-broken-sig.der"],
    ["full-forged-aki (signed by the rogue key)", "crls/issuing-ca-1/full-forged-aki.der"],
  ])("rejects %s as invalid_signature", async (_case, file) => {
    expect(await verifyCrlSignature(crlOf(file), spkiOf("issuing-ca-1"))).toMatchObject({
      ok: false,
      reason: "invalid_signature",
      algorithm: "sha256WithRSAEncryption",
    });
  });

  // C1: issuing-ca-1-renamed has the key of issuing-ca-1 but not its name.
  it("verifies full-01 with issuing-ca-1-renamed: issuer names are not compared", async () => {
    const renamed = certificateOf("issuing-ca-1-renamed");
    const crl = crlOf(FULL_01);
    expect(crl.issuer.isEqual(renamed.subject)).toBe(false);
    expect(await verifyCrlSignature(crl, renamed.subjectPublicKeyInfo)).toEqual({ ok: true });
    // What the old code did: PKIjs's own check refuses it for the name alone.
    expect(await crl.verify({ issuerCertificate: renamed })).toBe(false);
  });

  // C2: the critical private extension is the policy's business, not the signature check's.
  it("verifies full-unknown-critical, which PKIjs's own check refuses", async () => {
    const crl = crlOf("crls/issuing-ca-1/full-unknown-critical.der");
    expect(await verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).toEqual({ ok: true });
    expect(await crl.verify({ issuerCertificate: certificateOf("issuing-ca-1") })).toBe(false);
  });

  it.each([
    ["ed25519-ca", "Ed25519"],
    ["ed448-ca", "Ed448"],
  ])("refuses the %s CRL as unsupported_algorithm before any cryptography", async (ca, name) => {
    const spy = cryptoSpy();
    const run = verifyCrlSignature(crlOf(`crls/${ca}/full-01.der`), spkiOf(ca));
    await expect(run).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
      algorithm: name,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

// M12: the signature is checked over the TBSCertList octets as received.
describe("received TBS bytes", () => {
  /** [start, end) of the first element inside the outer SEQUENCE of a DER value. */
  function firstChild(der: Uint8Array): [number, number] {
    const lengthAt = (offset: number): [header: number, length: number] => {
      const first = der[offset + 1] ?? 0;
      if (first < 0x80) {
        return [2, first];
      }
      let length = 0;
      for (const byte of der.subarray(offset + 2, offset + 2 + (first & 0x7f))) {
        length = length * 256 + byte;
      }
      return [2 + (first & 0x7f), length];
    };
    const [outerHeader] = lengthAt(0);
    const [header, length] = lengthAt(outerHeader);
    return [outerHeader, outerHeader + header + length];
  }

  it("is the TBSCertList of the input, byte for byte", () => {
    for (const file of [FULL_01, ROOT_FULL_01, "crls/issuing-ca-1/full-pss.der"]) {
      const der = fixture(file);
      expect(parseCRL(der).tbsView, file).toEqual(der.subarray(...firstChild(der)));
    }
  });

  it("does not re-encode the decoded fields", async () => {
    const crl = crlOf(FULL_01);
    const received = crl.tbsView.slice();
    crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date("2030-01-01T00:00:00Z") });
    expect(encodedTbs(crl)).not.toEqual(received);
    expect(crl.tbsView).toEqual(received);
    expect(await verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).toEqual({ ok: true });
  });
});

// C4: the allow-list by OID, every entry signed and verified for real.
describe("allow-list", () => {
  type Hash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  const HASH_OIDS: Record<Hash, string> = {
    "SHA-1": "1.3.14.3.2.26",
    "SHA-256": "2.16.840.1.101.3.4.2.1",
    "SHA-384": "2.16.840.1.101.3.4.2.2",
    "SHA-512": "2.16.840.1.101.3.4.2.3",
  };
  const HASH_LENGTH: Record<Hash, number> = {
    "SHA-1": 20,
    "SHA-256": 32,
    "SHA-384": 48,
    "SHA-512": 64,
  };

  type Scheme = "pkcs1" | "pss" | "ecdsa";
  const ALLOWED: [oid: string, scheme: Scheme, hash?: Hash][] = [
    ["1.2.840.113549.1.1.5", "pkcs1", "SHA-1"],
    ["1.2.840.113549.1.1.11", "pkcs1", "SHA-256"],
    ["1.2.840.113549.1.1.12", "pkcs1", "SHA-384"],
    ["1.2.840.113549.1.1.13", "pkcs1", "SHA-512"],
    ["1.2.840.113549.1.1.10", "pss"],
    ["1.2.840.10045.4.1", "ecdsa", "SHA-1"],
    ["1.2.840.10045.4.3.2", "ecdsa", "SHA-256"],
    ["1.2.840.10045.4.3.3", "ecdsa", "SHA-384"],
    ["1.2.840.10045.4.3.4", "ecdsa", "SHA-512"],
  ];
  const REFUSED = [
    ...Object.keys(SIGNATURE_ALG_NAMES).filter(
      (oid) => !ALLOWED.some(([allowed]) => allowed === oid)
    ),
    "1.2.840.113549.1.1.1", // rsaEncryption is a key, not a signature algorithm
    "1.2.3.4",
  ];

  it("classifies every named signature algorithm", () => {
    expect(REFUSED).toEqual(
      expect.arrayContaining([
        "1.3.101.112",
        "1.3.101.113",
        "1.2.840.113549.1.1.14",
        "1.2.840.10045.4.3.1",
        "1.2.840.10040.4.3",
        "2.16.840.1.101.3.4.3.2",
        "1.2.156.10197.1.501",
        "1.2.840.113549.1.1.2",
        "1.2.840.113549.1.1.4",
      ])
    );
    for (const [oid] of ALLOWED) {
      expect(SIGNATURE_ALG_NAMES[oid], oid).toEqual(expect.any(String));
    }
  });

  /** full-01 re-signed: `signatureAlgorithm` in both places, `sign` over the new TBS. */
  async function resigned(
    signatureAlgorithm: pkijs.AlgorithmIdentifier,
    sign: (tbs: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>
  ): Promise<pkijs.CertificateRevocationList> {
    const crl = crlOf(FULL_01);
    crl.signature = signatureAlgorithm;
    crl.signatureAlgorithm = signatureAlgorithm;
    const tbs = encodedTbs(crl);
    crl.tbsView = tbs;
    crl.signatureValue = new asn1.BitString({ valueHex: await sign(tbs) });
    // Through the strict parser, as an upload would come.
    return parseCRL(derOf(crl));
  }

  async function spkiFrom(key: webcrypto.CryptoKey): Promise<pkijs.PublicKeyInfo> {
    const der = await crypto.subtle.exportKey("spki", key);
    return new pkijs.PublicKeyInfo({ schema: asn1.fromBER(der).result });
  }

  const rsa = crypto.subtle
    .generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: Uint8Array.of(1, 0, 1),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )
    .then(async ({ privateKey, publicKey }) => ({
      pkcs8: await crypto.subtle.exportKey("pkcs8", privateKey),
      spki: await spkiFrom(publicKey),
    }));

  async function rsaSigner(name: "RSASSA-PKCS1-v1_5" | "RSA-PSS", hash: Hash) {
    const { pkcs8 } = await rsa;
    return crypto.subtle.importKey("pkcs8", pkcs8, { name, hash }, false, ["sign"]);
  }

  const pssParams = (hash: Hash, saltLength = HASH_LENGTH[hash], maskHash: Hash = hash) =>
    new pkijs.RSASSAPSSParams({
      hashAlgorithm: algorithmId(HASH_OIDS[hash], new asn1.Null()),
      maskGenAlgorithm: algorithmId(
        MGF1,
        algorithmId(HASH_OIDS[maskHash], new asn1.Null()).toSchema()
      ),
      saltLength,
    }).toSchema();

  interface Case {
    oid: string;
    scheme: Scheme;
    hash: Hash;
    curve: string;
  }
  const cases = ALLOWED.flatMap(([oid, scheme, hash]): Case[] => {
    if (scheme === "pss") {
      return (Object.keys(HASH_OIDS) as Hash[]).map((pssHash) => ({
        oid,
        scheme,
        hash: pssHash,
        curve: "",
      }));
    }
    if (scheme === "ecdsa") {
      return ["P-256", "P-384", "P-521"].map((curve) => ({ oid, scheme, hash: hash!, curve }));
    }
    return [{ oid, scheme, hash: hash!, curve: "" }];
  });

  it.each(cases)("verifies $oid ($scheme $hash $curve) and rejects it tampered", async (c) => {
    let crl: pkijs.CertificateRevocationList;
    let spki: pkijs.PublicKeyInfo;
    if (c.scheme === "ecdsa") {
      const { privateKey, publicKey } = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: c.curve },
        true,
        ["sign", "verify"]
      );
      spki = await spkiFrom(publicKey);
      crl = await resigned(algorithmId(c.oid), async (tbs) =>
        pkijs.createCMSECDSASignature(
          await crypto.subtle.sign({ name: "ECDSA", hash: c.hash }, privateKey, tbs)
        )
      );
    } else {
      spki = (await rsa).spki;
      const pss = c.scheme === "pss";
      const key = await rsaSigner(pss ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", c.hash);
      const params = pss ? pssParams(c.hash) : new asn1.Null();
      crl = await resigned(algorithmId(c.oid, params), (tbs) =>
        crypto.subtle.sign(
          pss
            ? { name: "RSA-PSS", saltLength: HASH_LENGTH[c.hash] }
            : { name: "RSASSA-PKCS1-v1_5" },
          key,
          tbs
        )
      );
    }
    expect(await verifyCrlSignature(crl, spki)).toEqual({ ok: true });

    const tampered = parseCRL(derOf(crl));
    const bytes = tampered.tbsView;
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(await verifyCrlSignature(tampered, spki)).toMatchObject({
      ok: false,
      reason: "invalid_signature",
      algorithm: SIGNATURE_ALG_NAMES[c.oid],
    });
  });

  it.each(REFUSED)("refuses %s as unsupported_algorithm without cryptography", async (oid) => {
    const spy = cryptoSpy();
    const crl = crlOf(FULL_01);
    crl.signatureAlgorithm = algorithmId(oid, new asn1.Null());
    await expect(verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
      algorithm: SIGNATURE_ALG_NAMES[oid] ?? oid,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  describe("RSASSA-PSS parameters", () => {
    const PSS_FILE = "crls/issuing-ca-1/full-pss.der";
    function relabelled(params: asn1.BaseBlock | undefined) {
      const crl = crlOf(PSS_FILE);
      crl.signatureAlgorithm = algorithmId("1.2.840.113549.1.1.10", params);
      return crl;
    }

    it("honours the salt length", async () => {
      expect(
        await verifyCrlSignature(relabelled(pssParams("SHA-256")), spkiOf("issuing-ca-1"))
      ).toEqual({
        ok: true,
      });
      expect(
        await verifyCrlSignature(relabelled(pssParams("SHA-256", 20)), spkiOf("issuing-ca-1"))
      ).toMatchObject({ ok: false, reason: "invalid_signature" });
    });

    it("refuses MGF1 over another hash, which PKIjs alone would verify as MGF1 over the hash", async () => {
      const crl = relabelled(pssParams("SHA-256", 32, "SHA-1"));
      expect(
        await engine.verifyWithPublicKey(
          crl.tbsView,
          crl.signatureValue,
          spkiOf("issuing-ca-1"),
          crl.signatureAlgorithm
        )
      ).toBe(true);
      expect(await verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).toMatchObject({
        ok: false,
        reason: "unsupported_algorithm",
        algorithm: "RSASSA-PSS",
      });
    });

    it.each([
      ["no parameters", undefined],
      ["parameters that are not RSASSA-PSS-params", new asn1.Integer({ value: 1 })],
      [
        "a SEQUENCE PKIjs cannot decode",
        new asn1.Sequence({ value: [new asn1.Integer({ value: 1 })] }),
      ],
      [
        "SHA-224",
        new pkijs.RSASSAPSSParams({
          hashAlgorithm: algorithmId("2.16.840.1.101.3.4.2.4", new asn1.Null()),
          maskGenAlgorithm: algorithmId(MGF1, algorithmId("2.16.840.1.101.3.4.2.4").toSchema()),
          saltLength: 28,
        }).toSchema(),
      ],
      [
        "another mask generation function",
        new pkijs.RSASSAPSSParams({
          hashAlgorithm: algorithmId(HASH_OIDS["SHA-256"], new asn1.Null()),
          maskGenAlgorithm: algorithmId("1.2.3.4", algorithmId(HASH_OIDS["SHA-256"]).toSchema()),
          saltLength: 32,
        }).toSchema(),
      ],
      [
        "trailer field 2",
        new pkijs.RSASSAPSSParams({
          hashAlgorithm: algorithmId(HASH_OIDS["SHA-256"], new asn1.Null()),
          maskGenAlgorithm: algorithmId(MGF1, algorithmId(HASH_OIDS["SHA-256"]).toSchema()),
          saltLength: 32,
          trailerField: 2,
        }).toSchema(),
      ],
    ])("refuses %s as unsupported_algorithm without cryptography", async (_case, params) => {
      const spy = cryptoSpy();
      await expect(
        verifyCrlSignature(relabelled(params), spkiOf("issuing-ca-1"))
      ).resolves.toMatchObject({
        ok: false,
        reason: "unsupported_algorithm",
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("parameters of PKCS #1 v1.5 and ECDSA", () => {
    it("takes them absent or NULL", async () => {
      const rsaCrl = crlOf(FULL_01);
      rsaCrl.signatureAlgorithm = algorithmId(rsaCrl.signatureAlgorithm.algorithmId);
      expect(await verifyCrlSignature(rsaCrl, spkiOf("issuing-ca-1"))).toEqual({ ok: true });
      const ecCrl = crlOf(ROOT_FULL_01);
      expect(ecCrl.signatureAlgorithm.algorithmParams).toBeUndefined();
      ecCrl.signatureAlgorithm = algorithmId(ecCrl.signatureAlgorithm.algorithmId, new asn1.Null());
      expect(await verifyCrlSignature(ecCrl, spkiOf("root-ca"))).toEqual({ ok: true });
    });

    it.each([
      [FULL_01, "issuing-ca-1"],
      [ROOT_FULL_01, "root-ca"],
    ])("refuses any other parameters of %s", async (file, ca) => {
      const crl = crlOf(file);
      crl.signatureAlgorithm = algorithmId(
        crl.signatureAlgorithm.algorithmId,
        new asn1.Integer({ value: 0 })
      );
      expect(await verifyCrlSignature(crl, spkiOf(ca))).toMatchObject({
        ok: false,
        reason: "unsupported_algorithm",
      });
    });
  });
});

describe("issuer keys", () => {
  it.each([
    ["an RSA signature with an EC key", FULL_01, "root-ca"],
    ["an ECDSA signature with an RSA key", ROOT_FULL_01, "issuing-ca-1"],
    ["an ECDSA signature with an Ed25519 key", ROOT_FULL_01, "ed25519-ca"],
  ])("rejects %s as invalid_signature without cryptography", async (_case, file, ca) => {
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crlOf(file), spkiOf(ca))).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an RSASSA-PSS-restricted RSA key",
      FULL_01,
      withKeyAlgorithm(spkiOf("issuing-ca-1"), "1.2.840.113549.1.1.10"),
    ],
    [
      "an EC key on brainpoolP384r1",
      ROOT_FULL_01,
      withKeyAlgorithm(
        spkiOf("root-ca"),
        "1.2.840.10045.2.1",
        new asn1.ObjectIdentifier({ value: "1.3.36.3.3.2.8.1.1.11" })
      ),
    ],
    [
      "an EC key with explicit parameters",
      ROOT_FULL_01,
      withKeyAlgorithm(spkiOf("root-ca"), "1.2.840.10045.2.1", new asn1.Sequence()),
    ],
  ])("refuses %s as unsupported_algorithm without cryptography", async (_case, file, spki) => {
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crlOf(file), spki)).toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a key WebCrypto cannot import as invalid_signature, with the error only in detail", async () => {
    const spki = withKeyAlgorithm(spkiOf("issuing-ca-1"), "1.2.840.113549.1.1.1", new asn1.Null());
    spki.subjectPublicKey = new asn1.BitString({ valueHex: Uint8Array.of(0x30, 0x00).buffer });
    const run = verifyCrlSignature(crlOf(FULL_01), spki);
    await expect(run).resolves.toEqual({
      ok: false,
      reason: "invalid_signature",
      algorithm: "sha256WithRSAEncryption",
      detail: expect.any(String) as unknown,
    });
  });
});

// PKIjs reads ECDSA-Sig-Value leniently: it ignores trailing bytes and takes INTEGERs as unsigned
// octets. Every variant below verifies with PKIjs alone and must not here.
describe("ECDSA signature encoding", () => {
  const ROOT = () => spkiOf("root-ca");

  function sigParts(crl: pkijs.CertificateRevocationList): [Uint8Array, Uint8Array] {
    const parsed = asn1.fromBER(crl.signatureValue.valueBlock.valueHexView).result as asn1.Sequence;
    const [r, s] = parsed.valueBlock.value as asn1.Integer[];
    return [r!.valueBlock.valueHexView, s!.valueBlock.valueHexView];
  }

  const integer = (value: Uint8Array) => [0x02, value.length, ...value];
  const sequence = (...parts: number[][]) => {
    const body = parts.flat();
    return Uint8Array.from([0x30, body.length, ...body]);
  };

  /** root-ca/full-01 with these signature octets. */
  function withSignature(value: Uint8Array) {
    const crl = crlOf(ROOT_FULL_01);
    crl.signatureValue = new asn1.BitString({ valueHex: value.slice().buffer });
    return crl;
  }

  /** The non-DER form of one INTEGER: its 00 pad dropped (negative), or a redundant 00 added. */
  const nonDer = (value: Uint8Array) =>
    value[0] === 0 ? value.subarray(1) : Uint8Array.from([0, ...value]);

  const variants = (): [string, Uint8Array][] => {
    const original = crlOf(ROOT_FULL_01);
    const [r, s] = sigParts(original);
    const bytes = original.signatureValue.valueBlock.valueHexView;
    return [
      ["a trailing byte after the SEQUENCE", Uint8Array.from([...bytes, 0])],
      ["r not in DER", sequence(integer(nonDer(r)), integer(s))],
      ["s not in DER", sequence(integer(r), integer(nonDer(s)))],
    ];
  };

  it("verifies the original", async () => {
    expect(await verifyCrlSignature(crlOf(ROOT_FULL_01), ROOT())).toEqual({ ok: true });
  });

  it.each(variants())("rejects %s", async (_case, value) => {
    const crl = withSignature(value);
    expect(
      await engine.verifyWithPublicKey(
        crl.tbsView,
        crl.signatureValue,
        ROOT(),
        crl.signatureAlgorithm
      )
    ).toBe(true);
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crl, ROOT())).toMatchObject({
      ok: false,
      reason: "invalid_signature",
      algorithm: "ecdsa-with-SHA384",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an r longer than the curve order",
      (r: Uint8Array, s: Uint8Array) =>
        sequence(integer(Uint8Array.from([1, ...r.subarray(r[0] === 0 ? 1 : 0)])), integer(s)),
    ],
    ["a zero s", (r: Uint8Array) => sequence(integer(r), integer(Uint8Array.of(0)))],
    [
      "three INTEGERs",
      (r: Uint8Array, s: Uint8Array) => sequence(integer(r), integer(s), integer(s)),
    ],
    ["no SEQUENCE", (r: Uint8Array) => Uint8Array.from(integer(r))],
    ["nothing", () => new Uint8Array(0)],
  ])("rejects %s", async (_case, build) => {
    const [r, s] = sigParts(crlOf(ROOT_FULL_01));
    expect(await verifyCrlSignature(withSignature(build(r, s)), ROOT())).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects a signature BIT STRING with unused bits", async () => {
    const crl = crlOf(FULL_01);
    crl.signatureValue = new asn1.BitString({
      valueHex: crl.signatureValue.valueBlock.valueHexView.slice().buffer,
      unusedBits: 1,
    });
    expect(await verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
  });
});
