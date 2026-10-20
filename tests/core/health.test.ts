import { describe, expect, it } from "vitest";
import { applyConfig } from "../../src/core/admin.ts";
import { CATALOG_KEY, CONFIG_KEY, emptyCatalog } from "../../src/core/catalog.ts";
import { checkHealth } from "../../src/core/health.ts";
import { importCertificate } from "../../src/core/import.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, patchStore, putText } from "../helpers/app.ts";
import { cert, currentCrl, putCatalog } from "../helpers/catalog.ts";

async function storeWithConfig(text: string, base = new MemoryStore()): Promise<MemoryStore> {
  await putText(base, CONFIG_KEY, text);
  return base;
}

async function importInto(store: MemoryStore, name: string): Promise<string> {
  await importCertificate({ store, now: () => NOW }, fixture(cert(name).der));
  return cert(name).sha256;
}

/** A config text with one /ca/ path to `certificate`. */
function configServing(certificate: string): string {
  return JSON.stringify({
    version: 1,
    certificates: {},
    targets: {},
    paths: { "/ca/root-ca.crt": { certificate } },
  });
}

const DEGRADED_INVALID = { status: "degraded", checks: { store: "ok", configuration: "invalid" } };

describe("checkHealth", () => {
  it("reports a missing config.json as degraded", async () => {
    expect(await checkHealth(new MemoryStore())).toEqual({
      status: "degraded",
      checks: { store: "ok", configuration: "missing" },
    });
  });

  it("reports the minimal configuration as healthy (catalog.json missing)", async () => {
    expect(await checkHealth(await storeWithConfig(MINIMAL_CONFIG))).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it.each([
    "not json",
    '{"version":2}',
    "[]",
    "null",
    '{"version":"1"}',
    "1",
    // ConfigSchema is strict: a misspelled key or a missing map is invalid.
    '{"version":1,"certificates":{},"tagrets":{},"paths":{}}',
    '{"version":1,"certificates":{},"targets":{}}',
  ])("reports config.json %j as degraded / invalid", async (text) => {
    expect(await checkHealth(await storeWithConfig(text))).toEqual(DEGRADED_INVALID);
  });

  it("treats bytes that are not UTF-8 as invalid", async () => {
    const store = new MemoryStore();
    await store.put(CONFIG_KEY, Uint8Array.of(0x7b, 0xff, 0x7d));
    expect((await checkHealth(store)).checks.configuration).toBe("invalid");
  });

  it("runs the static rules: a path that breaks V2 is invalid", async () => {
    const store = new MemoryStore();
    const root = await importInto(store, "root-ca");
    const text = JSON.stringify({
      version: 1,
      certificates: {},
      targets: {},
      paths: { "/ca/root-ca.crt.pem": { certificate: root } },
    });
    expect(await checkHealth(await storeWithConfig(text, store))).toEqual(DEGRADED_INVALID);
  });

  it("runs the state rules: a reference to a certificate that is not imported is invalid", async () => {
    const store = new MemoryStore();
    await importInto(store, "root-ca");
    const text = configServing(cert("issuing-ca-1").sha256);
    expect(await checkHealth(await storeWithConfig(text, store))).toEqual(DEGRADED_INVALID);
  });

  it.each(["{not json", '{"version":1,"certificates":{},"targets":{},"certificatePaths":{}}'])(
    "reports catalog.json %j as degraded / invalid",
    async (text) => {
      const store = await storeWithConfig(MINIMAL_CONFIG);
      await putText(store, CATALOG_KEY, text);
      expect(await checkHealth(store)).toEqual(DEGRADED_INVALID);
    }
  );

  it("is healthy after import and apply", async () => {
    const store = new MemoryStore();
    const root = await importInto(store, "root-ca");
    const issuing = await importInto(store, "issuing-ca-1");
    const full = crypto.randomUUID();
    const config = {
      version: 1,
      certificates: { [root]: { label: "Root CA" } },
      targets: { [full]: { issuer: issuing, kind: "full", label: "Issuing CA 1" } },
      paths: {
        "/ca/root-ca.crt": { certificate: root },
        "/crl/issuing-ca-1.crl": { target: full },
      },
    };
    expect(await applyConfig({ store }, config, { ifNoneMatch: "*" })).toMatchObject({ config });
    expect(await checkHealth(store)).toEqual({
      status: "healthy",
      checks: { store: "ok", configuration: "ok" },
    });
  });

  it("does not run the migration rules: a published target missing from the config is ok", async () => {
    // V8 guards applyConfig; at rest this is the leftover of a cross-object race (slice 6).
    const store = await storeWithConfig(MINIMAL_CONFIG);
    const orphan = crypto.randomUUID();
    await putCatalog(store, {
      ...emptyCatalog(),
      targets: { [orphan]: { current: currentCrl("crls/root-ca/full-01.der", orphan) } },
    });
    expect((await checkHealth(store)).checks.configuration).toBe("ok");
  });

  it.each([CONFIG_KEY, CATALOG_KEY])(
    "reports a throwing get of %s as unhealthy / unknown and hands the error over",
    async (key) => {
      const failure = new Error("EACCES /data");
      const errors: unknown[] = [];
      const base = await storeWithConfig(MINIMAL_CONFIG);
      const store = patchStore(
        { get: (name) => (name === key ? Promise.reject(failure) : base.get(name)) },
        base
      );
      expect(await checkHealth(store, (error) => errors.push(error))).toEqual({
        status: "unhealthy",
        checks: { store: "error", configuration: "unknown" },
      });
      expect(errors).toEqual([failure]);
    }
  );

  it("is unhealthy when the catalog read fails even without a config", async () => {
    const store = patchStore({
      get: (name) =>
        name === CATALOG_KEY ? Promise.reject(new Error("io")) : Promise.resolve(null),
    });
    expect((await checkHealth(store)).status).toBe("unhealthy");
  });
});
