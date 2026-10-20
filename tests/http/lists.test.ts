// Invariants of the two lists (implementation slice 5a steps 5 and 7), after the intent of
// worker-aia-cdp@5b570aa:tests/worker/api-pagination.test.ts: one item per resource, never per
// stored object (no PEM companions, archives or aliases then; no blobs, history markers or
// superseded versions now), and no pagination left to skip or repeat. Downloads only ever name
// config.json paths (§10 #2), and a failing store is a 500, never `200 []` (§10 #9).
import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../../src/core/catalog.ts";
import type { Config } from "../../src/core/catalog.ts";
import {
  CertificateDetail,
  CertificateListItem,
  CrlTargetDetail,
  CrlTargetListItem,
} from "../../src/http/schemas.ts";
import { logRecords, patchStore, putText } from "../helpers/app.ts";
import { cert, putConfig } from "../helpers/catalog.ts";
import { IMPORTED } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { errorOf, expectInternal, okJson, readService, stateOf } from "../helpers/reads.ts";
import type { ReadService } from "../helpers/reads.ts";

const CERTIFICATES = "/api/v1/certificates";
const CRLS = "/api/v1/crls";
const STATS = "/api/v1/stats";

/** Every version of issuing-ca-1's two targets in turn: the superseded ones leave history. */
const PUBLISHED = [
  "crls/issuing-ca-1/full-01.der",
  "crls/issuing-ca-1/delta-01.der",
  "crls/issuing-ca-1/full-02.der",
  "crls/issuing-ca-1/delta-02.der",
  "crls/issuing-ca-1/full-03.der",
  "crls/root-ca/full-01.der",
];

/** Every imported certificate served under /ca/<name>.crt. */
const SERVED: SetupOptions = {
  configure: (config) => {
    for (const name of IMPORTED) {
      config.paths[`/ca/${name}.crt`] = { certificate: cert(name).sha256 };
    }
  },
};

function service(): Promise<ReadService> {
  return readService({ setup: SERVED, publish: PUBLISHED });
}

async function lists(app: ReadService["app"]) {
  return {
    certificates: CertificateListItem.array().parse(await okJson(await app.request(CERTIFICATES))),
    targets: CrlTargetListItem.array().parse(await okJson(await app.request(CRLS))),
  };
}

/** Each config.json path and its `.pem`: everything a downloads array may hold. */
function servedPaths(config: Config): Set<string> {
  return new Set(Object.keys(config.paths).flatMap((path) => [path, `${path}.pem`]));
}

describe("the lists", () => {
  it("have exactly one item per catalog certificate and per configured target", async () => {
    const svc = await service();
    const { config, catalog } = await stateOf(svc);
    // The store holds more than resources: history markers and superseded blobs.
    const keys = (await svc.base.list("")).map((object) => object.key);
    expect(keys.filter((key) => key.startsWith("history/")).length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.startsWith("blobs/crls/")).length).toBe(PUBLISHED.length);

    const { certificates, targets } = await lists(svc.app);
    expect(certificates.map((item) => item.id)).toEqual(Object.keys(catalog.certificates).sort());
    expect(targets.map((item) => item.targetId)).toEqual(Object.keys(config!.targets).sort());
    expect(new Set(targets.map((item) => item.targetId)).size).toBe(targets.length);
    // One current per published target: the last version of each.
    const currents = targets.flatMap((item) => (item.current === null ? [] : [item.current]));
    expect(currents).toHaveLength(3);
  });

  it("name only config.json paths as downloads, never a blob or history key", async () => {
    const svc = await service();
    const { config } = await stateOf(svc);
    const allowed = servedPaths(config!);
    const { certificates, targets } = await lists(svc.app);
    const details = [
      ...(await Promise.all(
        certificates.map(async (item) =>
          CertificateDetail.parse(await okJson(await svc.app.request(`${CERTIFICATES}/${item.id}`)))
        )
      )),
      ...(await Promise.all(
        targets.map(async (item) =>
          CrlTargetDetail.parse(await okJson(await svc.app.request(`${CRLS}/${item.targetId}`)))
        )
      )),
    ];
    const downloads = [...certificates, ...targets, ...details].flatMap((item) => item.downloads);
    expect(downloads.length).toBeGreaterThan(0);
    for (const path of downloads) {
      expect(allowed.has(path), path).toBe(true);
      expect(path).not.toMatch(/blobs\/|history\/|\.json$/);
    }
    // No store key anywhere in the bodies either.
    const text = JSON.stringify([certificates, targets, details]);
    expect(text).not.toMatch(/blobs\/|history\//);
  });

  it("leave out a current whose target config.json no longer defines", async () => {
    const svc = await service();
    const { config } = await stateOf(svc);
    const removed = svc.setup.target("root-ca", "full");
    const { [removed]: _target, ...targets } = config!.targets;
    const paths = Object.fromEntries(
      Object.entries(config!.paths).filter(
        ([, entry]) => !("target" in entry) || entry.target !== removed
      )
    );
    await putConfig(svc.base, { ...config!, targets, paths });
    const listed = (await lists(svc.app)).targets.map((item) => item.targetId);
    expect(listed).not.toContain(removed);
    expect(listed).toHaveLength(Object.keys(targets).length);
    await errorOf(await svc.app.request(`${CRLS}/${removed}`), 404, "not_found");
  });

  it("list the catalog alone without config.json, and no targets", async () => {
    const svc = await service();
    await svc.base.delete(CONFIG_KEY);
    const { certificates, targets } = await lists(svc.app);
    expect(certificates.map((item) => item.id)).toEqual(
      IMPORTED.map((name) => cert(name).sha256).sort()
    );
    for (const item of certificates) {
      expect(item).toMatchObject({ label: null, downloads: [], targets: [] });
    }
    expect(targets).toEqual([]);
  });
});

describe("a failing store", () => {
  const paths = (svc: ReadService) => [
    CERTIFICATES,
    `${CERTIFICATES}/${cert("root-ca").sha256}`,
    CRLS,
    `${CRLS}/${svc.setup.target("root-ca", "full")}`,
    STATS,
  ];

  it("is a 500 envelope on every read, never 200 [] or the exception text", async () => {
    const secret = "private storage details";
    const svc = await readService({
      wrap: (base) => patchStore({ get: () => Promise.reject(new Error(secret)) }, base),
    });
    for (const path of paths(svc)) {
      await expectInternal(await svc.app.request(path), secret);
      expect(logRecords(svc.deps).at(-2), path).toMatchObject({
        level: "error",
        msg: "unhandled_error",
        path,
      });
    }
  });

  it.each([
    ["config.json", CONFIG_KEY],
    ["catalog.json", "catalog.json"],
  ])("is a 500 when %s is not valid, never an empty list", async (_name, key) => {
    const svc = await readService();
    await putText(svc.base, key, '{"version":2}');
    for (const path of paths(svc)) {
      await expectInternal(await svc.app.request(path));
    }
  });
});
