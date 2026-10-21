import { readFileSync } from "node:fs";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_KEY,
  CatalogSchema,
  certificateBlobKey,
  CONFIG_KEY,
  decodeJson,
  emptyCatalog,
} from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/import.ts";
import type { ImportResult } from "../../src/core/import.ts";
import { parseCertificate } from "../../src/core/pki/parsers.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { buildCertificateSummary } from "../../src/core/summary/catalog-summary.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath, NOW } from "../fixtures/pki.ts";
import { patchStore, putText } from "../helpers/app.ts";
import { cert, certificateEntry, putCatalog } from "../helpers/catalog.ts";
import { berVariants, withEmptySerial, withOuterAlgorithm, withSkiPrefix } from "../helpers/pki.ts";
import { flakyStore, puts, recordingStore } from "../helpers/store.ts";

// importCertificate (slice 2 step 5): the second half of case 1 of
// worker-aia-cdp@5b570aa:tests/worker/r2-summary.test.ts (summary written at import), plus the
// zero-write rule (M9), the concurrent import and the orphan blob (C8).

// buildCertificateSummary stays the real one unless a case makes it return a summary the catalog
// format cannot hold.
vi.mock(import("../../src/core/summary/catalog-summary.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildCertificateSummary: vi.fn(actual.buildCertificateSummary) };
});

const noSleep = async () => undefined;

/** The DER of an AlgorithmIdentifier. */
function algorithm(algorithmId: string, algorithmParams?: asn1.BaseBlock): Uint8Array {
  const identifier = new pkijs.AlgorithmIdentifier({
    algorithmId,
    ...(algorithmParams === undefined ? {} : { algorithmParams }),
  });
  return new Uint8Array(identifier.toSchema().toBER(false));
}

function importInto(
  store: ObjectStore,
  bytes: Uint8Array,
  now: Date = NOW,
  sleep: (ms: number) => Promise<void> = noSleep
) {
  return importCertificate({ store, now: () => now, sleep }, bytes);
}

function text(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

async function storedCatalog(store: ObjectStore) {
  const object = await store.get(CATALOG_KEY);
  return object === null ? emptyCatalog() : CatalogSchema.parse(decodeJson(object.bytes));
}

// The certificate's notBefore with its trailing Z replaced: same length, no longer an RFC 5280
// UTCTime. The signature is not checked on import, so only the time rule can reject it.
function withBrokenNotBefore(name: string): Uint8Array {
  const der = fixture(cert(name).der);
  const iso = cert(name).notBefore; // 2025-01-01T00:00:00Z
  const utcTime = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const needle = [0x17, utcTime.length, ...new TextEncoder().encode(utcTime)];
  const at = der.findIndex((_, index) => needle.every((byte, k) => der[index + k] === byte));
  expect(at).toBeGreaterThan(0);
  const broken = der.slice();
  broken[at + needle.length - 1] = "0".charCodeAt(0);
  return broken;
}

describe("importCertificate", () => {
  it("imports DER, then answers the same certificate as PEM with unchanged and no write", async () => {
    const base = new MemoryStore();
    const store = recordingStore(base);
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const der = fixture(cert("issuing-ca-1").der);

    expect(await importInto(store, der)).toEqual({ outcome: "created", id, entry });
    expect(id).toBe(cert("issuing-ca-1").sha256);
    expect(entry).toMatchObject({
      key: `blobs/certificates/${id}.der`,
      size: der.byteLength,
      importedAt: NOW.toISOString(),
    });
    expect(puts(store)).toEqual([
      {
        key: certificateBlobKey(id),
        opts: { ifNoneMatch: "*", contentType: "application/pkix-cert" },
        ok: true,
      },
      { key: CATALOG_KEY, opts: { contentType: "application/json", ifNoneMatch: "*" }, ok: true },
    ]);
    expect((await base.get(certificateBlobKey(id)))!.bytes).toEqual(der);
    expect((await storedCatalog(base)).certificates).toEqual({ [id]: entry });

    store.writes.length = 0;
    const later = new Date(NOW.getTime() + 86_400_000);
    const pem = new TextEncoder().encode(text(cert("issuing-ca-1").pem));
    expect(await importInto(store, pem, later)).toEqual({ outcome: "unchanged", id, entry });
    expect(store.writes).toEqual([]);
  });

  // `aia import chain.pem` always sends PEM: the id, size, summary and blob describe the DER.
  it("imports PEM with the entry and blob of its DER", async () => {
    const store = new MemoryStore();
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const pem = new TextEncoder().encode(text(cert("issuing-ca-1").pem));
    expect(await importInto(store, pem)).toEqual({ outcome: "created", id, entry });
    expect((await store.get(certificateBlobKey(id)))!.bytes).toEqual(
      fixture(cert("issuing-ca-1").der)
    );
  });

  it.each<[string, () => Uint8Array, string]>([
    ["invalid/garbage.txt", () => fixture("invalid/garbage.txt"), "der"],
    ["invalid/empty.bin", () => fixture("invalid/empty.bin"), "der"],
    ["a CRL", () => fixture("crls/issuing-ca-1/full-01.der"), "structure"],
    ["a CRL as PEM", () => fixture("crls/root-ca/full-01.pem"), "pem_label"],
    [
      "a two-certificate bundle",
      () => new TextEncoder().encode(text(cert("issuing-ca-1").pem) + text(cert("root-ca").pem)),
      "pem_blocks",
    ],
    ["a broken notBefore", () => withBrokenNotBefore("issuing-ca-1"), "time"],
    ["an empty serialNumber", () => withEmptySerial(fixture(cert("issuing-ca-1").der)), "der"],
    // RFC 5280 §4.1.1.2: the outer signatureAlgorithm must equal the TBS signature. The outer one
    // is outside the signature, so anyone holding the file can rewrite it (root-ca signs with
    // ecdsa-with-SHA384, parameters absent).
    [
      "an outer signatureAlgorithm with another OID",
      () =>
        withOuterAlgorithm(fixture(cert("root-ca").der), () => algorithm("1.2.840.10045.4.3.2")),
      "signature_algorithm_mismatch",
    ],
    [
      "an outer signatureAlgorithm with parameters the TBS signature lacks",
      () =>
        withOuterAlgorithm(fixture(cert("root-ca").der), () =>
          algorithm("1.2.840.10045.4.3.3", new asn1.Null())
        ),
      "signature_algorithm_mismatch",
    ],
    ...berVariants(fixture(cert("issuing-ca-1").der)).map(
      ([variant, bytes]): [string, () => Uint8Array, string] => [
        `BER with ${variant}`,
        () => bytes,
        "der",
      ]
    ),
  ])("rejects %s without writing", async (_, bytes, reason) => {
    const store = recordingStore();
    expect(await importInto(store, bytes())).toEqual({
      error: "invalid_certificate",
      details: { reason },
    });
    expect(store.writes).toEqual([]);
  });

  it("rejects a summary the catalog format cannot hold before writing anything", async () => {
    const real = vi.mocked(buildCertificateSummary).getMockImplementation()!;
    vi.mocked(buildCertificateSummary).mockImplementationOnce(async (certificate, der) => ({
      ...(await real(certificate, der)),
      serialNumber: "",
    }));
    const store = recordingStore();
    expect(await importInto(store, fixture(cert("root-ca").der))).toEqual({
      error: "invalid_certificate",
      details: { reason: "structure" },
    });
    expect(store.writes).toEqual([]);
  });

  it("ends two concurrent imports of one certificate as created + unchanged", async () => {
    const base = new MemoryStore();
    // The first four catalog reads are released in pairs: both imports pass the early check, then
    // both read the catalog for their write before either writes. Without the barrier, one import
    // could finish before the other one's early check (WebCrypto runs on the thread pool).
    const waiting: (() => void)[] = [];
    let reads = 0;
    const barrier = patchStore(
      {
        get: async (key) => {
          if (key === CATALOG_KEY && reads < 4) {
            reads++;
            await new Promise<void>((release) => {
              waiting.push(release);
              if (waiting.length === 2) {
                waiting.splice(0).forEach((resume) => {
                  resume();
                });
              }
            });
          }
          return base.get(key);
        },
      },
      base
    );
    const store = recordingStore(barrier);
    const der = fixture(cert("root-ca").der);
    const results = await Promise.all([importInto(store, der), importInto(store, der)]);
    const outcomes = results.map((result) => ("outcome" in result ? result.outcome : result.error));
    expect(outcomes.sort()).toEqual(["created", "unchanged"]);
    const { id, entry } = await certificateEntry("root-ca");
    for (const result of results) {
      expect(result).toMatchObject({ id, entry });
    }
    expect((await storedCatalog(base)).certificates).toEqual({ [id]: entry });
    // Both wrote create-only: one blob put was already there, and the loser of the catalog write
    // found the entry when it read the catalog again.
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [certificateBlobKey(id), true],
      [certificateBlobKey(id), false],
      [CATALOG_KEY, true],
      [CATALOG_KEY, false],
    ]);
  });

  it("imports a certificate whose key id would decode as a broken UTCTime", async () => {
    const der = withSkiPrefix(fixture(cert("issuing-ca-1").der), [0x17, 0x12]);
    const summary = await buildCertificateSummary(parseCertificate(der), der);
    expect(summary.subjectKeyId).toMatch(/^1712/);
    expect(await importInto(new MemoryStore(), der)).toMatchObject({
      outcome: "created",
      entry: { summary },
    });
  });

  it("imports EdDSA CA certificates", async () => {
    const store = new MemoryStore();
    for (const name of ["ed25519-ca", "ed448-ca"]) {
      expect(await importInto(store, fixture(cert(name).der))).toMatchObject({
        outcome: "created",
        id: cert(name).sha256,
      });
    }
  });

  it("does not configure anything: no target, no config.json (M23)", async () => {
    const store = new MemoryStore();
    await importInto(store, fixture(cert("issuing-ca-1").der));
    expect((await storedCatalog(store)).targets).toEqual({});
    expect(await store.head(CONFIG_KEY)).toBeNull();
  });

  it("adds the catalog entry when an earlier attempt left the blob behind", async () => {
    const base = new MemoryStore();
    const { id, entry } = await certificateEntry("issuing-ca-2");
    const der = fixture(cert("issuing-ca-2").der);
    await base.put(certificateBlobKey(id), der);
    const store = recordingStore(base);
    expect(await importInto(store, der)).toEqual({ outcome: "created", id, entry });
    expect(puts(store).map((put) => put.ok)).toEqual([false, true]);
  });

  it("leaves only an unreferenced blob when the catalog write keeps losing (C8)", async () => {
    const base = new MemoryStore();
    await putCatalog(base, emptyCatalog());
    const store = recordingStore(flakyStore(base, { failIfMatch: 4 }));
    const id = cert("root-ca").sha256;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const result: ImportResult = await importInto(store, fixture(cert("root-ca").der), NOW, sleep);
    expect(result).toEqual({ error: "concurrent_update", id });
    // 1 attempt + 3 retries (plan §5.5), with the backoff of step 4 in between.
    expect(sleeps).toEqual([250, 500, 1000]);
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [certificateBlobKey(id), true],
      ...Array.from({ length: 4 }, () => [CATALOG_KEY, false]),
    ]);
    expect(await storedCatalog(base)).toEqual(emptyCatalog());
    expect(await base.head(certificateBlobKey(id))).not.toBeNull();
  });

  it("throws on an invalid stored catalog before writing anything", async () => {
    const base = new MemoryStore();
    await putText(base, CATALOG_KEY, "{not json");
    const store = recordingStore(base);
    await expect(importInto(store, fixture(cert("root-ca").der))).rejects.toThrow(/catalog\.json/);
    expect(store.writes).toEqual([]);
  });
});
