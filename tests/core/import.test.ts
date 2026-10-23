import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, certificateBlobKey, readCatalog } from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/import.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath, NOW } from "../fixtures/pki.ts";
import { patchStore } from "../helpers/app.ts";
import { cert, certificateEntry } from "../helpers/catalog.ts";
import { withOuterAlgorithm } from "../helpers/pki.ts";
import { puts, recordingStore } from "../helpers/store.ts";

function importInto(store: ObjectStore, bytes: Uint8Array, now: Date = NOW) {
  return importCertificate({ store, now: () => now, sleep: async () => undefined }, bytes);
}

async function storedCertificates(store: ObjectStore) {
  return (await readCatalog(store)).catalog.certificates;
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
    expect(await storedCertificates(base)).toEqual({ [id]: entry });

    store.writes.length = 0;
    const later = new Date(NOW.getTime() + 86_400_000);
    const pem = readFileSync(fixturePath(cert("issuing-ca-1").pem));
    expect(await importInto(store, pem, later)).toEqual({ outcome: "unchanged", id, entry });
    expect(store.writes).toEqual([]);
  });

  // RFC 5280 §4.1.1.2: the outer signatureAlgorithm is outside the signature, so anyone holding
  // the file can rewrite it; it must equal the TBS signature.
  it("rejects an outer signatureAlgorithm other than the TBS signature without writing", async () => {
    const store = recordingStore();
    const der = withOuterAlgorithm(fixture(cert("root-ca").der), (algorithm) =>
      // ecdsa-with-SHA384 → ecdsa-with-SHA256: the last octet of the OID.
      Uint8Array.from([...algorithm.subarray(0, -1), 0x02])
    );
    expect(await importInto(store, der)).toEqual({
      error: "invalid_certificate",
      details: { reason: "signature_algorithm_mismatch" },
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
    expect(await storedCertificates(base)).toEqual({ [id]: entry });
    // Both wrote create-only: one blob put was already there, and the loser of the catalog write
    // found the entry when it read the catalog again.
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [certificateBlobKey(id), true],
      [certificateBlobKey(id), false],
      [CATALOG_KEY, true],
      [CATALOG_KEY, false],
    ]);
  });
});
