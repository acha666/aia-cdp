import { describe, expect, it } from "vitest";
import {
  applyConfig,
  checkConfigState,
  checkConfigStatic,
  validateConfig,
} from "../../src/core/admin.ts";
import type { ConfigCheck, ConfigIssue, ConfigPrecondition } from "../../src/core/admin.ts";
import {
  CATALOG_KEY,
  CONFIG_KEY,
  emptyCatalog,
  encodeJson,
  InvalidStoredObjectError,
  readCatalog,
} from "../../src/core/catalog.ts";
import type { Catalog, Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { importCertificate } from "../../src/core/import.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { fixture, NOW } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, putText } from "../helpers/app.ts";
import { cert, currentCrl, putCatalog } from "../helpers/catalog.ts";
import { flakyStore, opaqueEtagStore, puts, recordingStore } from "../helpers/store.ts";

// validateConfig (V1–V9, slice 2 step 6) and applyConfig (owner decision 2: no rebind ledger, only
// config.json is written). The V6 cases rewrite "different issuers cannot share…" of
// worker-aia-cdp@5b570aa:tests/worker/crl-upload.test.ts as a configuration rule.

const IMPORTED = ["root-ca", "issuing-ca-1", "issuing-ca-2", "issuing-ca-1-renewed", "leaf-min"];

const id = (name: string) => cert(name).sha256;

async function storeWith(names: string[] = IMPORTED): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const name of names) {
    const result = await importCertificate(
      { store, now: () => NOW, sleep: async () => undefined },
      fixture(cert(name).der)
    );
    expect(result).toMatchObject({ outcome: "created" });
  }
  return store;
}

async function catalogOf(store: ObjectStore): Promise<Catalog> {
  return (await readCatalog(store)).catalog;
}

function target(issuer: string, kind: "full" | "delta", label = `${issuer.slice(0, 8)} ${kind}`) {
  return { issuer: id(issuer), kind, label };
}

/** A valid configuration: root-ca with a full CRL, issuing-ca-1 with full + delta. */
function baseline() {
  const ids = { root: crypto.randomUUID(), full: crypto.randomUUID(), delta: crypto.randomUUID() };
  const config: Config = {
    version: 1,
    certificates: {
      [id("root-ca")]: { label: "Root CA" },
      [id("issuing-ca-1")]: { label: "Issuing CA 1" },
    },
    targets: {
      [ids.root]: target("root-ca", "full"),
      [ids.full]: target("issuing-ca-1", "full"),
      [ids.delta]: target("issuing-ca-1", "delta"),
    },
    paths: {
      "/ca/root-ca.crt": { certificate: id("root-ca") },
      "/ca/issuing-ca-1.crt": { certificate: id("issuing-ca-1") },
      "/crl/root-ca.crl": { target: ids.root },
      "/crl/issuing-ca-1.crl": { target: ids.full },
      "/dcrl/issuing-ca-1.crl": { target: ids.delta },
    },
  };
  return { ids, config };
}

/** `[rule, path]` of each issue, in order (messages are for people). */
function rules(check: ConfigCheck | ConfigIssue[]): [string, (string | number)[]][] {
  const issues = Array.isArray(check) ? check : check.ok ? [] : check.issues;
  return issues.map((issue) => [issue.rule, issue.path]);
}

function issuesOf(result: Awaited<ReturnType<typeof applyConfig>>): ConfigIssue[] {
  if (!("error" in result) || result.error !== "config_invalid") {
    throw new Error(`expected config_invalid, got ${JSON.stringify(result)}`);
  }
  return result.details.issues;
}

/** Applies `config` as the first configuration or over the stored one. */
async function apply(store: ObjectStore, config: unknown) {
  const stored = await store.get(CONFIG_KEY);
  const precondition: ConfigPrecondition =
    stored === null ? { ifNoneMatch: "*" } : { ifMatch: await sha256Hex(stored.bytes) };
  return applyConfig({ store }, config, precondition);
}

describe("static layer (checkConfigStatic)", () => {
  it("accepts the minimal configuration and the baseline without a catalog", () => {
    expect(checkConfigStatic(JSON.parse(MINIMAL_CONFIG))).toMatchObject({ ok: true });
    const { config } = baseline();
    expect(checkConfigStatic(config)).toEqual({ ok: true, config });
  });

  it("V1: reports every schema issue, and nothing else", () => {
    const { config } = baseline();
    const upper = id("root-ca").toUpperCase();
    const check = checkConfigStatic({
      ...config,
      tagrets: {},
      certificates: { [upper]: { label: "Root CA" } },
      paths: { ...config.paths, "/ca/bad path.crt": { certificate: id("root-ca") } },
    });
    expect(rules(check)).toEqual([
      ["V1", ["certificates", upper]],
      ["V1", []],
    ]);
    const messages = check.ok ? [] : check.issues.map((issue) => issue.message);
    expect(messages).toEqual([
      expect.stringContaining("lowercase hex SHA-256"),
      'Unrecognized key: "tagrets"',
    ]);
  });

  it("V1: rejects a target id that is not an RFC 9562 UUID", () => {
    const check = checkConfigStatic({
      version: 1,
      certificates: {},
      targets: { "00000000-0000-0000-0000-000000000001": target("root-ca", "full") },
      paths: {},
    });
    expect(rules(check)).toEqual([["V1", ["targets", "00000000-0000-0000-0000-000000000001"]]]);
  });

  it.each([
    "/ca/bad path.crt",
    "/ca/",
    "/ca",
    "/ca//root.crt",
    "/ca/root.crt/",
    "/ca/%72oot.crt",
    "/ca/../root.crt",
    "/ca/./root.crt",
    "/ca/root.crt.pem",
    "/ca/zürich.crt",
    "/CA/root.crt",
    "/certs/root.crt",
    "ca/root.crt",
  ])("V2: rejects %j", (path) => {
    const config = { ...baseline().config, paths: { [path]: { certificate: id("root-ca") } } };
    expect(rules(checkConfigStatic(config))).toEqual([["V2", ["paths", path]]]);
  });

  it("V2: accepts the RFC 3986 unreserved set and nested segments", () => {
    const paths = Object.fromEntries(
      ["/ca/Root_CA~1.crt", "/ca/a..b/x.pem.crt", "/ca/.hidden-ok", "/ca/2026/root-ca.crt"].map(
        (path) => [path, { certificate: id("root-ca") }]
      )
    );
    expect(checkConfigStatic({ ...baseline().config, paths })).toMatchObject({ ok: true });
  });

  it("V3: the prefix decides the kind of resource", () => {
    const { ids, config } = baseline();
    const check = checkConfigStatic({
      ...config,
      paths: {
        "/ca/root-ca.crl": { target: ids.root },
        "/crl/root-ca.crt": { certificate: id("root-ca") },
        "/crl/delta.crl": { target: ids.delta },
        "/dcrl/full.crl": { target: ids.full },
      },
    });
    expect(rules(check)).toEqual([
      ["V3", ["paths", "/ca/root-ca.crl"]],
      ["V3", ["paths", "/crl/root-ca.crt"]],
      ["V3", ["paths", "/crl/delta.crl", "target"]],
      ["V3", ["paths", "/dcrl/full.crl", "target"]],
    ]);
  });

  it("V4 (static): a path's target must be in targets", () => {
    const { config } = baseline();
    const missing = crypto.randomUUID();
    const check = checkConfigStatic({
      ...config,
      paths: { ...config.paths, "/crl/missing.crl": { target: missing } },
    });
    expect(rules(check)).toEqual([["V4", ["paths", "/crl/missing.crl", "target"]]]);
  });

  it("V6 (static): one target per issuer and kind", () => {
    const { config } = baseline();
    const second = crypto.randomUUID();
    const check = checkConfigStatic({
      ...config,
      targets: { ...config.targets, [second]: target("issuing-ca-1", "full", "again") },
    });
    expect(rules(check)).toEqual([["V6", ["targets", second]]]);
  });
});

describe("state layer (checkConfigState)", () => {
  it("accepts the baseline once its certificates are imported", async () => {
    const store = await storeWith();
    expect(validateConfig(baseline().config, { catalog: await catalogOf(store) })).toMatchObject({
      ok: true,
    });
  });

  it("V4: certificates, path certificates and target issuers must be imported", async () => {
    const { ids, config } = baseline();
    const catalog = await catalogOf(await storeWith(["root-ca"]));
    expect(rules(checkConfigState(config, catalog))).toEqual([
      ["V4", ["certificates", id("issuing-ca-1")]],
      ["V4", ["paths", "/ca/issuing-ca-1.crt", "certificate"]],
      ["V4", ["targets", ids.full, "issuer"]],
      ["V4", ["targets", ids.delta, "issuer"]],
    ]);
  });

  it("V5: a target's issuer needs a Subject Key Identifier", async () => {
    const catalog = await catalogOf(await storeWith());
    expect(catalog.certificates[id("leaf-min")]!.summary.subjectKeyId).toBeNull();
    const { config } = baseline();
    const leaf = crypto.randomUUID();
    const withLeaf = {
      ...config,
      targets: { ...config.targets, [leaf]: target("leaf-min", "full") },
    };
    expect(rules(checkConfigState(withLeaf, catalog))).toEqual([
      ["V5", ["targets", leaf, "issuer"]],
    ]);
  });

  it("V6: certificates sharing an SKI cannot each have a target of one kind", async () => {
    const catalog = await catalogOf(await storeWith());
    const ski = catalog.certificates[id("issuing-ca-1")]!.summary.subjectKeyId;
    expect(catalog.certificates[id("issuing-ca-1-renewed")]!.summary.subjectKeyId).toBe(ski);
    const { ids, config } = baseline();
    const renewed = crypto.randomUUID();

    const sameKind = {
      ...config,
      targets: { ...config.targets, [renewed]: target("issuing-ca-1-renewed", "full") },
    };
    expect(rules(checkConfigState(sameKind, catalog))).toEqual([
      ["V6", ["targets", renewed, "issuer"]],
    ]);

    // The renewed certificate may take over the delta CRL while the original keeps the full one.
    const { [ids.delta]: _delta, ...targets } = config.targets;
    const split = {
      ...config,
      targets: { ...targets, [renewed]: target("issuing-ca-1-renewed", "delta") },
      paths: { ...config.paths, "/dcrl/issuing-ca-1.crl": { target: renewed } },
    };
    expect(validateConfig(split, { catalog })).toMatchObject({ ok: true });
  });
});

describe("applyConfig", () => {
  it("writes only config.json, in the canonical format, and returns its digest", async () => {
    const base = await storeWith();
    const catalogBefore = await base.get(CATALOG_KEY);
    const store = recordingStore(base);
    const { config } = baseline();

    const result = await applyConfig({ store }, config, { ifNoneMatch: "*" });
    const stored = await base.get(CONFIG_KEY);
    expect(stored!.bytes).toEqual(encodeJson(config));
    expect(result).toEqual({ config, sha256: await sha256Hex(stored!.bytes) });
    expect(puts(store)).toEqual([
      { key: CONFIG_KEY, opts: { contentType: "application/json", ifNoneMatch: "*" }, ok: true },
    ]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(catalogBefore!.bytes);
  });

  it("replaces with the store's ETag, not with the digest it compared", async () => {
    const base = await storeWith();
    const store = recordingStore(opaqueEtagStore(base));
    const first = await apply(store, baseline().config);
    expect(first).toMatchObject({ sha256: expect.any(String) as unknown });
    const etag = (await store.get(CONFIG_KEY))!.etag;
    expect(etag).toMatch(/^store:/);

    const second = baseline().config;
    expect(
      await applyConfig({ store }, second, { ifMatch: (first as { sha256: string }).sha256 })
    ).toMatchObject({ config: second });
    expect(puts(store).at(-1)).toEqual({
      key: CONFIG_KEY,
      opts: { contentType: "application/json", ifMatch: etag },
      ok: true,
    });
  });

  describe("precondition", () => {
    it.each<[string, (digest: string) => ConfigPrecondition]>([
      ["If-None-Match: * while a config exists", () => ({ ifNoneMatch: "*" })],
      [
        "a stale If-Match",
        (digest) => ({ ifMatch: digest.replace(/^./, (c) => (c === "0" ? "1" : "0")) }),
      ],
      ["a quoted If-Match (the route unquotes)", (digest) => ({ ifMatch: `"${digest}"` })],
    ])("fails with %s, before validation and without a write", async (_, precondition) => {
      const base = await storeWith();
      await apply(base, baseline().config);
      const digest = await sha256Hex((await base.get(CONFIG_KEY))!.bytes);
      const store = recordingStore(base);
      expect(await applyConfig({ store }, { invalid: true }, precondition(digest))).toEqual({
        error: "precondition_failed",
      });
      expect(store.writes).toEqual([]);
    });

    it("fails with If-Match while no config exists", async () => {
      const store = recordingStore(await storeWith());
      const digest = await sha256Hex(encodeJson(baseline().config));
      expect(await applyConfig({ store }, baseline().config, { ifMatch: digest })).toEqual({
        error: "precondition_failed",
      });
      expect(store.writes).toEqual([]);
    });

    it("reports a write lost to a concurrent apply as precondition_failed, without retry", async () => {
      const base = await storeWith();
      await apply(base, baseline().config);
      const store = recordingStore(flakyStore(base, { failIfMatch: 1 }));
      expect(await apply(store, baseline().config)).toEqual({ error: "precondition_failed" });
      expect(puts(store).map((put) => put.ok)).toEqual([false]);
    });
  });

  it("returns every issue at once and writes nothing", async () => {
    const store = recordingStore(await storeWith());
    const { ids, config } = baseline();
    await putCatalog(store, {
      ...(await catalogOf(store)),
      targets: {
        [ids.full]: { current: await currentCrl("crls/issuing-ca-1/full-01.der", ids.full) },
      },
    });
    expect(await apply(store, config)).toMatchObject({ sha256: expect.any(String) as unknown });
    store.writes.length = 0;

    const leaf = crypto.randomUUID();
    const duplicate = crypto.randomUUID();
    const renewed = crypto.randomUUID();
    const { [ids.full]: _removed, ...targets } = config.targets;
    const { "/crl/issuing-ca-1.crl": _path, ...paths } = config.paths;
    const next = {
      ...config,
      certificates: { ...config.certificates, [id("rogue-ca")]: { label: "never imported" } },
      targets: {
        ...targets,
        [ids.root]: target("issuing-ca-2", "full"),
        [leaf]: target("leaf-min", "full"),
        [duplicate]: target("issuing-ca-1", "delta"),
        [renewed]: target("issuing-ca-1-renewed", "delta"),
      },
      paths: {
        ...paths,
        "/ca/bad path.crt": { certificate: id("root-ca") },
        "/ca/root.crl": { target: ids.root },
        "/ca/root-ca.crt": { certificate: id("issuing-ca-2") },
      },
    };
    const issues = issuesOf(await apply(store, next));
    expect(rules(issues)).toEqual([
      ["V2", ["paths", "/ca/bad path.crt"]],
      ["V3", ["paths", "/ca/root.crl"]],
      ["V4", ["certificates", id("rogue-ca")]],
      ["V5", ["targets", leaf, "issuer"]],
      ["V6", ["targets", duplicate]],
      ["V6", ["targets", renewed, "issuer"]],
      ["V7", ["paths", "/ca/root-ca.crt", "certificate"]],
      ["V8", ["targets", ids.full]],
      ["V9", ["targets", ids.root, "issuer"]],
    ]);
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true);
    expect(store.writes).toEqual([]);
  });

  describe("V7: a /ca/ path keeps its certificate", () => {
    it("rejects a direct rebind", async () => {
      const store = await storeWith();
      const { config } = baseline();
      await apply(store, config);
      const rebound = {
        ...config,
        paths: { ...config.paths, "/ca/root-ca.crt": { certificate: id("issuing-ca-2") } },
      };
      expect(rules(issuesOf(await apply(store, rebound)))).toEqual([
        ["V7", ["paths", "/ca/root-ca.crt", "certificate"]],
      ]);
    });

    // The accepted gap of owner decision 2: without a ledger, removing the path in one apply and
    // re-adding it for another certificate in a later one is not detected. The operator must use
    // a new path for a new certificate (downloads are cached immutable for a year).
    it("does not detect a rebind in two applies (remove, then re-add)", async () => {
      const store = await storeWith();
      const { config } = baseline();
      await apply(store, config);
      const { "/ca/root-ca.crt": _removed, ...paths } = config.paths;
      expect(await apply(store, { ...config, paths })).toMatchObject({ config: { paths } });
      const readded = {
        ...config,
        paths: { ...paths, "/ca/root-ca.crt": { certificate: id("issuing-ca-2") } },
      };
      expect(await apply(store, readded)).toMatchObject({ config: readded });
    });
  });

  describe("V8: a target with a current CRL is retired before removal", () => {
    async function published() {
      const store = await storeWith();
      const { ids, config } = baseline();
      await apply(store, config);
      await putCatalog(store, {
        ...(await catalogOf(store)),
        targets: {
          [ids.full]: { current: await currentCrl("crls/issuing-ca-1/full-01.der", ids.full) },
          [ids.delta]: { current: null },
        },
      });
      return { store, ids, config };
    }

    function without(config: Config, targetId: string): Config {
      const { [targetId]: _target, ...targets } = config.targets;
      const paths = Object.fromEntries(
        Object.entries(config.paths).filter(
          ([, entry]) => !("target" in entry) || entry.target !== targetId
        )
      );
      return { ...config, targets, paths };
    }

    it("rejects removing a target that has a current CRL", async () => {
      const { store, ids, config } = await published();
      expect(rules(issuesOf(await apply(store, without(config, ids.full))))).toEqual([
        ["V8", ["targets", ids.full]],
      ]);
    });

    it("accepts removing a retired target (current null) and keeping a published one", async () => {
      const { store, ids, config } = await published();
      expect(await apply(store, without(config, ids.delta))).toMatchObject({
        sha256: expect.any(String) as unknown,
      });
    });

    it("applies without a current config too", async () => {
      const store = await storeWith();
      const targetId = crypto.randomUUID();
      await putCatalog(store, {
        ...(await catalogOf(store)),
        targets: {
          [targetId]: { current: await currentCrl("crls/root-ca/full-01.der", targetId) },
        },
      });
      expect(rules(issuesOf(await apply(store, JSON.parse(MINIMAL_CONFIG))))).toEqual([
        ["V8", ["targets", targetId]],
      ]);
    });
  });

  describe("V9: a target id keeps its issuer and kind", () => {
    it.each([
      ["issuer", { issuer: id("issuing-ca-2") }],
      ["kind", { kind: "delta" as const }],
    ])("rejects a changed %s", async (field, change) => {
      const store = await storeWith();
      const { ids, config } = baseline();
      await apply(store, config);
      const changed = {
        ...config,
        targets: { [ids.root]: { ...config.targets[ids.root]!, ...change } },
        paths: { "/ca/root-ca.crt": { certificate: id("root-ca") } },
      };
      expect(rules(issuesOf(await apply(store, changed)))).toEqual([
        ["V9", ["targets", ids.root, field]],
      ]);
    });

    it("accepts a changed label", async () => {
      const store = await storeWith();
      const { ids, config } = baseline();
      await apply(store, config);
      const relabeled = {
        ...config,
        targets: { ...config.targets, [ids.root]: { ...config.targets[ids.root]!, label: "New" } },
      };
      expect(await apply(store, relabeled)).toMatchObject({ config: relabeled });
    });
  });

  it("skips V7 and V9 when the current config is not valid, and still replaces it", async () => {
    const store = await storeWith();
    const { ids, config } = baseline();
    // Written out of band: valid JSON, but `note` is not in the schema.
    await putText(store, CONFIG_KEY, JSON.stringify({ ...config, note: "hand edited" }));
    const next = {
      ...config,
      targets: { ...config.targets, [ids.root]: target("issuing-ca-2", "full") },
      paths: { ...config.paths, "/ca/root-ca.crt": { certificate: id("issuing-ca-2") } },
    };
    expect(await apply(store, next)).toMatchObject({ config: next });
  });

  it("throws on an invalid catalog.json and writes nothing", async () => {
    const base = await storeWith();
    await putText(base, CATALOG_KEY, '{"version":1}');
    const store = recordingStore(base);
    await expect(apply(store, baseline().config)).rejects.toBeInstanceOf(InvalidStoredObjectError);
    expect(store.writes).toEqual([]);
  });

  it("accepts the minimal configuration on an empty store", async () => {
    const store = new MemoryStore();
    expect(await apply(store, JSON.parse(MINIMAL_CONFIG))).toMatchObject({
      config: { version: 1, certificates: {}, targets: {}, paths: {} },
    });
    expect(await catalogOf(store)).toEqual(emptyCatalog());
    expect(await store.get(CATALOG_KEY)).toBeNull();
  });
});
