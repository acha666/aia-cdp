import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The committed tree that tests/fixtures/generate-test-data.sh writes (pnpm run fixtures). Digests,
// key ids, sizes and signatures change with every generation: read them from the files or from
// `manifest`, never write them as literals (implementation §2.5).

/** Absolute path of tests/fixtures/pki/, with a trailing slash. */
export const FIXTURES_DIR = fileURLToPath(new URL("./pki/", import.meta.url));

// Shapes of manifest.json; the values are the contract in implementation appendix D.

export type CertificateKey = "ec-p384" | "ec-p256" | "rsa-2048" | "ed25519" | "ed448";
export type CrlKind = "full" | "delta";
/** First-upload outcome: the target is configured and has no current CRL yet. */
export type CrlExpect =
  | "created"
  | "issuer_not_found"
  | "invalid_signature"
  | "unknown_critical_extension"
  | "scoped_crl_unsupported"
  | "invalid_crl"
  | "not_yet_valid"
  | "unsupported_algorithm";
export type ScenarioOutcome =
  "created" | "unchanged" | "updated" | "stale_crl" | "conflict" | "non_orderable";

export interface ManifestCertificate {
  name: string;
  /** Paths relative to FIXTURES_DIR. */
  der: string;
  pem: string;
  /** Name of the issuing certificate (itself for self-signed ones). */
  issuer: string;
  key: CertificateKey;
  /** Uppercase hex of the INTEGER content, as `openssl x509 -serial` prints it (not decimal). */
  serial: string;
  /** ISO 8601 UTC, e.g. 2025-01-01T00:00:00Z. */
  notBefore: string;
  notAfter: string;
  /** Imported into the catalog by publish tests (appendix D.1 `import`). */
  import: boolean;
  sha256: string;
  role: string;
}

export interface ManifestCrl {
  /** Path relative to FIXTURES_DIR: crls/<issuer>/<case>.der. */
  file: string;
  issuer: string;
  /** Whose key signed it; differs from `issuer` only for full-forged-aki (rogue-ca). */
  signer: string;
  kind: CrlKind;
  /** Decimal string, or null when the CRL has no CRL Number extension. */
  crlNumber: string | null;
  /** Delta CRL indicator (decimal); null for full CRLs. */
  baseCrlNumber: string | null;
  thisUpdate: string;
  /** null when the CRL has no nextUpdate. */
  nextUpdate: string | null;
  /** AD CS Next CRL Publish (1.3.6.1.4.1.311.21.4); null when the CRL has no such extension. */
  nextPublish: string | null;
  revoked: number;
  expect: CrlExpect;
  sha256: string;
  note: string;
}

export interface ManifestInvalid {
  /** Path relative to FIXTURES_DIR: invalid/<name>. */
  file: string;
  expect: "invalid_crl";
  note: string;
}

export interface ManifestScenario {
  /** CRL file that is current before the upload, or null for an empty target. */
  current: string | null;
  upload: string;
  outcome: ScenarioOutcome;
}

export interface Manifest {
  version: 1;
  /** `openssl version` of the generating host. */
  openssl: string;
  /** The clock to inject in tests: 2026-01-04T00:00:00Z. */
  now: string;
  certificates: ManifestCertificate[];
  crls: ManifestCrl[];
  invalid: ManifestInvalid[];
  scenarios: ManifestScenario[];
}

export const manifest = JSON.parse(
  readFileSync(`${FIXTURES_DIR}manifest.json`, "utf8")
) as Manifest;

export const NOW = new Date(manifest.now);

/** Absolute path of a fixture, given relative to FIXTURES_DIR (e.g. "certs/root-ca.der"). */
export function fixturePath(path: string): string {
  return `${FIXTURES_DIR}${path}`;
}

/** The bytes of a fixture, in a fresh ArrayBuffer (usable with WebCrypto as is). */
export function fixture(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fixturePath(path)));
}
