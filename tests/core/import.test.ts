import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
import type { ObjectStore } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, fixturePath, NOW } from "../fixtures/pki.ts";
import { putText } from "../helpers/app.ts";
import { cert, certificateEntry, putCatalog } from "../helpers/catalog.ts";
import { flakyStore, puts, recordingStore } from "../helpers/store.ts";

// importCertificate (slice 2 step 5): the second half of case 1 of
// worker-aia-cdp@5b570aa:tests/worker/r2-summary.test.ts (summary written at import), plus the
// zero-write rule (M9), the concurrent import and the orphan blob (C8).

const noSleep = async () => undefined;

function importInto(store: ObjectStore, bytes: Uint8Array, now: Date = NOW) {
  return importCertificate({ store, now: () => now, sleep: noSleep }, bytes);
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

  it.each([
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
  ])("rejects %s without writing", async (_, bytes, reason) => {
    const store = recordingStore();
    expect(await importInto(store, bytes())).toEqual({
      error: "invalid_certificate",
      details: { reason },
    });
    expect(store.writes).toEqual([]);
  });

  it("ends two concurrent imports of one certificate as created + unchanged", async () => {
    const base = new MemoryStore();
    const store = recordingStore(base);
    const der = fixture(cert("root-ca").der);
    const results = await Promise.all([importInto(store, der), importInto(store, der)]);
    const outcomes = results.map((result) => ("outcome" in result ? result.outcome : result.error));
    expect(outcomes.sort()).toEqual(["created", "unchanged"]);
    const { id, entry } = await certificateEntry("root-ca");
    for (const result of results) {
      expect(result).toMatchObject({ id, entry });
    }
    expect((await storedCatalog(base)).certificates).toEqual({ [id]: entry });
    // Both got past the first catalog read: the loser found the entry inside the retry.
    const catalogPuts = puts(store).filter((put) => put.key === CATALOG_KEY);
    expect(catalogPuts.map((put) => put.ok)).toEqual([true, false]);
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
    const result: ImportResult = await importInto(store, fixture(cert("root-ca").der));
    expect(result).toEqual({ error: "concurrent_update", id });
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
