// Shared by the slice 5b page, query and upload tests (not a test file itself): API bodies shaped by
// @/client/types with the facts of tests/fixtures/pki (ids, serials, validity, CRL numbers and
// times from manifest.json; subject names from generate-test-data.sh), a fetch stub that answers
// hc's requests by method and path, and a deferred promise for ordering tests.
import { vi } from "vitest";
import manifest from "../fixtures/pki/manifest.json";
import type {
  AlgorithmIdentifier,
  CertificateDetail,
  CertificateListItem,
  CrlTargetDetail,
  CrlTargetListItem,
  Extension,
  Name,
  PublishedCrl,
  RevokedCertificate,
  Stats,
  Time,
} from "@/client/types";

/** manifest.now: the clock of every test that depends on one. */
export const NOW = manifest.now;

export const TARGET_IDS = {
  issuingFull: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405162",
  issuingDelta: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405163",
  rootFull: "4f0d3c1a-6a8e-4b8f-9c55-1d2e3f405164",
} as const;

type FixtureName = "root-ca" | "issuing-ca-1" | "issuing-ca-2";

const SUBJECT_CN: Record<FixtureName, string> = {
  "root-ca": "Example Root CA (ECC P-384)",
  "issuing-ca-1": "Example Issuing CA 01 (RSA)",
  "issuing-ca-2": "Example Issuing CA 02 (RSA)",
};

function fixtureCertificate(name: FixtureName) {
  const entry = manifest.certificates.find((certificate) => certificate.name === name);
  if (entry === undefined) {
    throw new Error(`No fixture certificate ${name}`);
  }
  return entry;
}

function fixtureCrl(file: string) {
  const entry = manifest.crls.find((crl) => crl.file === file);
  if (entry === undefined) {
    throw new Error(`No fixture CRL ${file}`);
  }
  return entry;
}

/** The catalog's timestamp form (millisecond precision). */
export function iso(value: string): string {
  return new Date(value).toISOString();
}

export function time(value: string): Time {
  const normalized = iso(value);
  return {
    iso: normalized,
    type: "utcTime",
    raw: `${normalized.replace(/[-:T]/g, "").slice(2, 14)}Z`,
  };
}

/** "/C=US/O=Example PKI/CN=<cn>", as generate-test-data.sh writes the CA subjects. */
export function exampleName(commonName: string): Name {
  const attribute = (oid: string, name: string, value: string) => ({
    attributes: [
      { type: { oid, name }, value: { string: value, encoding: "printableString" as const } },
    ],
  });
  return {
    commonName,
    organization: "Example PKI",
    organizationalUnit: null,
    country: "US",
    stateOrProvince: null,
    locality: null,
    rdnSequence: [
      attribute("2.5.4.6", "C", "US"),
      attribute("2.5.4.10", "O", "Example PKI"),
      attribute("2.5.4.3", "CN", commonName),
    ],
    rfc4514: `CN=${commonName},O=Example PKI,C=US`,
  };
}

/** Lowercase hex of `length` bytes, all `byte`: a stand-in for digests the manifest does not list. */
export function hexBytes(byte: string, length: number): string {
  return byte.repeat(length);
}

const ECDSA_SHA384: AlgorithmIdentifier = {
  algorithm: { oid: "1.2.840.10045.4.3.3", name: "ecdsa-with-SHA384" },
};

/** crls/issuing-ca-1/full-pss: "RSASSA-PSS SHA-256, MGF1 SHA-256, salt 32". */
export const RSASSA_PSS: AlgorithmIdentifier = {
  algorithm: { oid: "1.2.840.113549.1.1.10", name: "RSASSA-PSS" },
  parameters: {
    rawHex:
      "3034a00f300d06096086480165030402010500a11c301a06092a864886f70d010108300d06096086480165030402010500a203020120",
    parsed: {
      type: "rsassaPss",
      hashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
      maskGenAlgorithm: { oid: "1.2.840.113549.1.1.8", name: "MGF1" },
      maskGenHashAlgorithm: { oid: "2.16.840.1.101.3.4.2.1", name: "SHA-256" },
      saltLength: 32,
      trailerField: 1,
    },
  },
};

const BASIC_CONSTRAINTS_CA: Extension = {
  extnID: { oid: "2.5.29.19", name: "basicConstraints" },
  critical: true,
  extnValue: { hex: "30030101ff", byteLength: 5 },
  parseStatus: "parsed",
  parsed: { extensionType: "basicConstraints", cA: true },
};

const CRL_NUMBER_OID = { oid: "2.5.29.20", name: "cRLNumber" };

export function certificateItem(
  name: FixtureName,
  overrides: Partial<CertificateListItem> = {}
): CertificateListItem {
  const fixture = fixtureCertificate(name);
  const issuerCN = SUBJECT_CN[fixture.issuer as FixtureName];
  return {
    id: fixture.sha256,
    label: null,
    importedAt: iso("2026-01-02T00:00:00Z"),
    size: 600,
    summary: {
      subjectCN: SUBJECT_CN[name],
      issuerCN,
      serialNumber: fixture.serial,
      notBefore: iso(fixture.notBefore),
      notAfter: iso(fixture.notAfter),
      subjectKeyId: hexBytes("1a", 20),
      authorityKeyId: hexBytes("2b", 20),
      sha1: hexBytes("3c", 20),
    },
    downloads: [`/ca/${name}.crt`, `/ca/${name}.crt.pem`],
    targets: [],
    ...overrides,
  } satisfies CertificateListItem;
}

/** root-ca as the detail route returns it: an ECDSA P-384 self-signed CA. */
export function rootDetail(overrides: Partial<CertificateDetail> = {}): CertificateDetail {
  const item = certificateItem("root-ca");
  const fixture = fixtureCertificate("root-ca");
  return {
    ...item,
    fingerprints: { sha1: item.summary.sha1, sha256: item.id },
    tbsCertificate: {
      version: { raw: 2, display: "v3" },
      serialNumber: { hex: fixture.serial, decimal: String(Number.parseInt(fixture.serial, 16)) },
      signature: ECDSA_SHA384,
      issuer: exampleName(SUBJECT_CN["root-ca"]),
      validity: { notBefore: time(fixture.notBefore), notAfter: time(fixture.notAfter) },
      subject: exampleName(SUBJECT_CN["root-ca"]),
      subjectPublicKeyInfo: {
        algorithm: {
          algorithm: { oid: "1.2.840.10045.2.1", name: "ecPublicKey" },
          parameters: {
            rawHex: "06052b81040022",
            parsed: { type: "objectIdentifier", oid: { oid: "1.3.132.0.34", name: "P-384" } },
          },
        },
        subjectPublicKey: { hex: `04${hexBytes("ab", 96)}`, bitLength: 776, unusedBits: 0 },
        parsed: {
          type: "ec",
          curve: { oid: "1.3.132.0.34", name: "P-384" },
          point: { hex: `04${hexBytes("ab", 96)}`, x: hexBytes("ab", 48), y: hexBytes("ab", 48) },
          keySize: 384,
        },
        fingerprints: { sha1: hexBytes("4d", 20), sha256: hexBytes("5e", 32) },
      },
      extensions: { count: 1, critical: 1, items: [BASIC_CONSTRAINTS_CA] },
    },
    signatureAlgorithm: ECDSA_SHA384,
    signatureValue: {
      hex: hexBytes("30", 104),
      bitLength: 832,
      unusedBits: 0,
      parsed: { type: "ecdsa", r: hexBytes("7a", 48), s: hexBytes("7b", 48) },
    },
    ...overrides,
  } satisfies CertificateDetail;
}

/** The current CRL of a list item, from a manifest entry. */
function currentOf(file: string) {
  const crl = fixtureCrl(file);
  return {
    sha256: crl.sha256,
    size: 400,
    publishedAt: iso("2026-01-03T12:00:00Z"),
    summary: {
      crlNumber: crl.crlNumber,
      baseCrlNumber: crl.baseCrlNumber,
      thisUpdate: iso(crl.thisUpdate),
      nextUpdate: crl.nextUpdate === null ? null : iso(crl.nextUpdate),
      revokedCount: crl.revoked,
      sha1: hexBytes("6f", 20),
      nextPublish: crl.nextPublish === null ? null : iso(crl.nextPublish),
    },
  };
}

const ISSUING = certificateItem("issuing-ca-1");
const ROOT = certificateItem("root-ca");

/**
 * The three targets of the page tests: issuing-ca-1 full (full-adcs, current until its Next CRL
 * Publish) and delta (unpublished), root-ca full (full-01).
 */
export function targetItems(): CrlTargetListItem[] {
  return [
    {
      targetId: TARGET_IDS.issuingFull,
      kind: "full",
      label: "Issuing CA 01",
      issuer: { id: ISSUING.id, label: null, subjectCN: SUBJECT_CN["issuing-ca-1"] },
      downloads: ["/crl/ca01.crl", "/crl/ca01.crl.pem"],
      current: currentOf("crls/issuing-ca-1/full-adcs.der"),
    },
    {
      targetId: TARGET_IDS.issuingDelta,
      kind: "delta",
      label: "Issuing CA 01",
      issuer: { id: ISSUING.id, label: null, subjectCN: SUBJECT_CN["issuing-ca-1"] },
      downloads: ["/dcrl/ca01.crl", "/dcrl/ca01.crl.pem"],
      current: null,
    },
    {
      targetId: TARGET_IDS.rootFull,
      kind: "full",
      label: "Root CA",
      issuer: { id: ROOT.id, label: "Root", subjectCN: SUBJECT_CN["root-ca"] },
      downloads: ["/crl/root.crl", "/crl/root.crl.pem"],
      current: currentOf("crls/root-ca/full-01.der"),
    },
  ] satisfies CrlTargetListItem[];
}

/** `count` revoked entries with serials 01, 02, ... (no entry extensions). */
export function revokedEntries(count: number): RevokedCertificate[] {
  return Array.from({ length: count }, (_, index) => ({
    userCertificate: { hex: (index + 1).toString(16).toUpperCase().padStart(4, "0") },
    revocationDate: time("2026-01-01T00:00:00Z"),
  }));
}

/**
 * issuing-ca-1's full target with crls/issuing-ca-1/full-pss as its current CRL (RSASSA-PSS with
 * parameters), or unpublished with `current: null`.
 */
export function issuingFullDetail(
  options: { published?: boolean; revoked?: RevokedCertificate[] } = {}
): CrlTargetDetail {
  const item = targetItems()[0]!;
  if (options.published === false) {
    return { ...item, current: null } satisfies CrlTargetDetail;
  }
  const crl = fixtureCrl("crls/issuing-ca-1/full-pss.der");
  const current = currentOf("crls/issuing-ca-1/full-pss.der");
  const revoked = options.revoked ?? revokedEntries(crl.revoked);
  return {
    ...item,
    current: {
      ...current,
      summary: { ...current.summary, revokedCount: revoked.length },
      verifier: ISSUING.id,
      fingerprints: { sha1: current.summary.sha1, sha256: current.sha256 },
      tbsCertList: {
        version: { raw: 1, display: "v2" },
        signature: RSASSA_PSS,
        issuer: exampleName(SUBJECT_CN["issuing-ca-1"]),
        thisUpdate: time(crl.thisUpdate),
        ...(crl.nextUpdate === null ? {} : { nextUpdate: time(crl.nextUpdate) }),
        revokedCertificates: { count: revoked.length, items: revoked },
        crlExtensions: {
          count: 1,
          critical: 0,
          items: [
            {
              extnID: CRL_NUMBER_OID,
              critical: false,
              extnValue: { hex: "020110", byteLength: 3 },
              parseStatus: "parsed",
              parsed: { extensionType: "cRLNumber", number: crl.crlNumber ?? "0" },
            },
          ],
        },
      },
      signatureAlgorithm: RSASSA_PSS,
      signatureValue: { hex: hexBytes("5a", 256), bitLength: 2048, unusedBits: 0 },
    },
  } satisfies CrlTargetDetail;
}

export const STATS = {
  certificates: 2,
  targets: { full: 2, delta: 1 },
  published: { full: 2, delta: 0 },
  totalRevocations: 2,
  derBytes: 2000,
} satisfies Stats;

/** The 201 / 200 body of an upload to issuing-ca-1's full target (full-02). */
export function publishedCrl(outcome: PublishedCrl["outcome"]): PublishedCrl {
  const crl = fixtureCrl("crls/issuing-ca-1/full-02.der");
  return {
    outcome,
    target: TARGET_IDS.issuingFull,
    kind: "full",
    sha256: crl.sha256,
    crlNumber: crl.crlNumber,
    baseCrlNumber: null,
    thisUpdate: iso(crl.thisUpdate),
    nextUpdate: crl.nextUpdate === null ? null : iso(crl.nextUpdate),
    issuer: ISSUING.id,
    downloads: ["/crl/ca01.crl", "/crl/ca01.crl.pem"],
  } satisfies PublishedCrl;
}

// Fetch ------------------------------------------------------------------------------------------

/** A v1 error envelope. */
export function envelope(status: number, code: string, details?: unknown): Response {
  return Response.json(
    { error: { code, message: `${code} (test)`, ...(details === undefined ? {} : { details }) } },
    { status }
  );
}

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs the global fetch: `routes` maps "GET /api/v1/crls" (method, space, path) to a handler. The
 * health check answers healthy unless routed; anything else is a 404 envelope, so a test sees an
 * unexpected request in `calls` rather than a hang.
 */
export function stubApi(routes: Record<string, Handler | undefined>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), "http://test");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key];
    if (handler !== undefined) {
      return handler(init);
    }
    if (key === "GET /api/v1/health") {
      return Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } });
    }
    return envelope(404, "not_found");
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /** "METHOD /path" of every request except the health check, in order. */
    calls: () =>
      fetchMock.mock.calls
        .map(([input, init]) => {
          const url = new URL(input instanceof Request ? input.url : input.toString(), "http://t");
          return `${init?.method ?? "GET"} ${url.pathname}`;
        })
        .filter((call) => call !== "GET /api/v1/health"),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
