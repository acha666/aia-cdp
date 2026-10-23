// What the two lists hold: one item per resource, never per stored object (no blobs, history
// markers or superseded versions), and a failing store is a 500 on every read, never `200 []`.
import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../../src/core/catalog.ts";
import { CertificateListItem, CrlTargetListItem } from "../../src/http/schemas.ts";
import { logRecords, patchStore, putText } from "../helpers/app.ts";
import { cert } from "../helpers/catalog.ts";
import { IMPORTED } from "../helpers/publish.ts";
import { expectInternal, okJson, readService, stateOf } from "../helpers/reads.ts";
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

async function lists(app: ReadService["app"]) {
  return {
    certificates: CertificateListItem.array().parse(await okJson(await app.request(CERTIFICATES))),
    targets: CrlTargetListItem.array().parse(await okJson(await app.request(CRLS))),
  };
}

describe("the lists", () => {
  it("have exactly one item per catalog certificate and per configured target", async () => {
    const svc = await readService({ publish: PUBLISHED });
    const { config, catalog } = await stateOf(svc);
    // The store holds more than resources: history markers and superseded blobs.
    const keys = (await svc.base.list("")).map((object) => object.key);
    expect(keys.filter((key) => key.startsWith("history/")).length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.startsWith("blobs/crls/")).length).toBe(PUBLISHED.length);

    const { certificates, targets } = await lists(svc.app);
    expect(certificates.map((item) => item.id)).toEqual(Object.keys(catalog.certificates).sort());
    expect(targets.map((item) => item.targetId)).toEqual(Object.keys(config!.targets).sort());
    // One current per published target: the last version of each.
    expect(targets.filter((item) => item.current !== null)).toHaveLength(3);
  });

  it("list the catalog alone without config.json, and no targets", async () => {
    const svc = await readService({ publish: PUBLISHED });
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
