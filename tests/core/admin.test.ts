import { describe, expect, it } from "vitest";
import { applyConfig, validateConfig } from "../../src/core/admin.ts";
import type { ConfigCheck, ConfigIssue, ConfigPrecondition } from "../../src/core/admin.ts";
import {
  CATALOG_KEY,
  certificateBlobKey,
  CONFIG_KEY,
  encodeJson,
  InvalidStoredObjectError,
  readCatalog,
} from "../../src/core/catalog.ts";
import type { Catalog, Config } from "../../src/core/catalog.ts";
import { deleteCertificate, importCertificate } from "../../src/core/certificates.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, fixture, NOW } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, putText } from "../helpers/app.ts";
import { currentCrl, putCatalog } from "../helpers/catalog.ts";
import { flakyStore, puts, recordingStore } from "../helpers/store.ts";

// The config rules V1–V9 (validateConfig), applyConfig, which writes only config.json, and
// deleteCertificate.

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

/** `config` without the target `targetId` and its paths. */
function without(config: Config, targetId: string): Config {
  const { [targetId]: _target, ...targets } = config.targets;
  const paths = Object.fromEntries(
    Object.entries(config.paths).filter(
      ([, entry]) => !("target" in entry) || entry.target !== targetId
    )
  );
  return { ...config, targets, paths };
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

describe("config rules", () => {
  it("accept the minimal configuration, and the baseline once its certificates are imported", async () => {
    expect(validateConfig(JSON.parse(MINIMAL_CONFIG))).toMatchObject({ ok: true });
    const { config } = baseline();
    expect(validateConfig(config)).toEqual({ ok: true, config });
    const catalog = await catalogOf(await storeWith());
    expect(validateConfig(config, { catalog })).toEqual({ ok: true, config });
  });

  it("V1: reports every schema issue, and nothing else", () => {
    const { config } = baseline();
    const upper = id("root-ca").toUpperCase();
    const check = validateConfig({
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

  it("V2: a path is /ca/, /crl/ or /dcrl/ and segments of the RFC 3986 unreserved set", () => {
    const accepted = [
      "/ca/Root_CA~1.crt",
      "/ca/a..b/x.pem.crt",
      "/ca/.hidden-ok",
      "/ca/2026/r.crt",
    ];
    const rejected = [
      "/ca/bad path.crt",
      "/ca/",
      "/ca//root.crt",
      "/ca/%72oot.crt",
      "/ca/../root.crt",
      "/ca/root.crt.pem",
      "/CA/root.crt",
      "/certs/root.crt",
    ];
    const paths = Object.fromEntries(
      [...accepted, ...rejected].map((path) => [path, { certificate: id("root-ca") }])
    );
    expect(rules(validateConfig({ ...baseline().config, paths }))).toEqual(
      rejected.map((path) => ["V2", ["paths", path]])
    );
  });

  it("V3: the prefix decides the kind of resource", () => {
    const { ids, config } = baseline();
    const check = validateConfig({
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

  it("V4: path targets are defined, certificates and target issuers imported", async () => {
    const { ids, config } = baseline();
    const missing = crypto.randomUUID();
    const value = {
      ...config,
      paths: { ...config.paths, "/crl/missing.crl": { target: missing } },
    };
    const catalog = await catalogOf(await storeWith(["root-ca"]));
    expect(rules(validateConfig(value, { catalog }))).toEqual([
      ["V4", ["paths", "/crl/missing.crl", "target"]],
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
    expect(rules(validateConfig(withLeaf, { catalog }))).toEqual([
      ["V5", ["targets", leaf, "issuer"]],
    ]);
  });

  it("V6: one target per issuer and kind, also across certificates sharing an SKI", async () => {
    const catalog = await catalogOf(await storeWith());
    const ski = catalog.certificates[id("issuing-ca-1")]!.summary.subjectKeyId;
    expect(catalog.certificates[id("issuing-ca-1-renewed")]!.summary.subjectKeyId).toBe(ski);
    const { ids, config } = baseline();
    const second = crypto.randomUUID();
    const renewed = crypto.randomUUID();

    const doubled = {
      ...config,
      targets: {
        ...config.targets,
        [second]: target("issuing-ca-1", "full", "again"),
        [renewed]: target("issuing-ca-1-renewed", "full"),
      },
    };
    expect(rules(validateConfig(doubled, { catalog }))).toEqual([
      ["V6", ["targets", second]],
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

  it("a target with a current CRL may be removed: that retires it", async () => {
    const store = await storeWith();
    const { ids, config } = baseline();
    await apply(store, config);
    await putCatalog(store, {
      ...(await catalogOf(store)),
      targets: {
        [ids.full]: { current: await currentCrl("crls/issuing-ca-1/full-01.der", ids.full) },
      },
    });
    const retired = without(config, ids.full);
    expect(await apply(store, retired)).toMatchObject({ config: retired });
  });

  it("V9: a target id keeps its issuer and kind, and may change its label", async () => {
    const store = await storeWith();
    const { ids, config } = baseline();
    await apply(store, config);
    const changed = {
      ...config,
      targets: { [ids.root]: target("issuing-ca-2", "delta") },
      paths: { "/ca/root-ca.crt": { certificate: id("root-ca") } },
    };
    expect(rules(issuesOf(await apply(store, changed)))).toEqual([
      ["V9", ["targets", ids.root, "issuer"]],
      ["V9", ["targets", ids.root, "kind"]],
    ]);
    const relabeled = {
      ...config,
      targets: { ...config.targets, [ids.root]: { ...config.targets[ids.root]!, label: "New" } },
    };
    expect(await apply(store, relabeled)).toMatchObject({ config: relabeled });
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

  it("reports a write lost to a concurrent apply as precondition_failed, without retry", async () => {
    const base = await storeWith();
    await apply(base, baseline().config);
    const store = recordingStore(flakyStore(base, { failIfMatch: 1 }));
    expect(await apply(store, baseline().config)).toEqual({ error: "precondition_failed" });
    expect(puts(store).map((put) => put.ok)).toEqual([false]);
  });

  it("returns the issues of every layer at once, by rule, and writes nothing", async () => {
    const base = await storeWith();
    const { config } = baseline();
    await apply(base, config);
    const store = recordingStore(base);
    const leaf = crypto.randomUUID();
    const next = {
      ...config,
      targets: { ...config.targets, [leaf]: target("leaf-min", "full") },
      paths: {
        ...config.paths,
        "/ca/root-ca.crt": { certificate: id("issuing-ca-2") },
        "/ca/bad path.crt": { certificate: id("root-ca") },
      },
    };
    const issues = issuesOf(await apply(store, next));
    expect(rules(issues)).toEqual([
      ["V2", ["paths", "/ca/bad path.crt"]],
      ["V5", ["targets", leaf, "issuer"]],
      ["V7", ["paths", "/ca/root-ca.crt", "certificate"]],
    ]);
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it("throws on an invalid catalog.json and writes nothing", async () => {
    const base = await storeWith();
    await putText(base, CATALOG_KEY, '{"version":1}');
    const store = recordingStore(base);
    await expect(apply(store, baseline().config)).rejects.toBeInstanceOf(InvalidStoredObjectError);
    expect(store.writes).toEqual([]);
  });
});

describe("deleteCertificate", () => {
  it("removes an unreferenced certificate and its blob; importing it again creates it", async () => {
    const base = await storeWith();
    await apply(base, baseline().config);
    const store = recordingStore(base);
    const leaf = id("leaf-min");
    expect(await deleteCertificate({ store }, leaf)).toEqual({ deleted: true });
    expect((await catalogOf(base)).certificates[leaf]).toBeUndefined();
    expect(store.writes.map((write) => [write.op, write.key])).toEqual([
      ["put", CATALOG_KEY],
      ["delete", certificateBlobKey(leaf)],
    ]);
    expect(await deleteCertificate({ store }, leaf)).toEqual({ error: "not_found" });
    const again = await importCertificate({ store, now: () => NOW }, fixture(cert("leaf-min").der));
    expect(again).toMatchObject({ outcome: "created" });
  });

  it("refuses a referenced certificate, naming every reference, and writes nothing", async () => {
    const base = await storeWith();
    const { ids, config } = baseline();
    await apply(base, config);
    // issuing-ca-2 verified the current CRL of a target that is no longer in config.json.
    const removed = crypto.randomUUID();
    await putCatalog(base, {
      ...(await catalogOf(base)),
      targets: {
        [removed]: { current: await currentCrl("crls/issuing-ca-2/full-01.der", removed) },
      },
    });
    const store = recordingStore(base);
    expect(await deleteCertificate({ store }, id("issuing-ca-1"))).toEqual({
      error: "referenced",
      details: {
        references: [
          { object: "config.json", path: ["certificates", id("issuing-ca-1")] },
          { object: "config.json", path: ["paths", "/ca/issuing-ca-1.crt", "certificate"] },
          { object: "config.json", path: ["targets", ids.full, "issuer"] },
          { object: "config.json", path: ["targets", ids.delta, "issuer"] },
        ],
      },
    });
    expect(await deleteCertificate({ store }, id("issuing-ca-2"))).toEqual({
      error: "referenced",
      details: {
        references: [{ object: "catalog.json", path: ["targets", removed, "current", "verifier"] }],
      },
    });
    expect(store.writes).toEqual([]);
  });
});
