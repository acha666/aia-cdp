// The two lists without config.json (the catalog's certificates, no targets), and a failing store
// is a 500 on every read, never `200 []`.
import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../../src/core/catalog.ts";
import { CertificateListItem, CrlTargetListItem } from "../../src/http/schemas.ts";
import { cert } from "../fixtures/pki.ts";
import { logRecords, patchStore } from "../helpers/app.ts";
import { IMPORTED } from "../helpers/publish.ts";
import { expectInternal, okJson, readService } from "../helpers/reads.ts";
import type { ReadService } from "../helpers/reads.ts";

const CERTIFICATES = "/api/v1/certificates";
const CRLS = "/api/v1/crls";

/** Every version of issuing-ca-1's two targets in turn, and root-ca's full CRL. */
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
    certificates: await okJson(await app.request(CERTIFICATES), CertificateListItem.array()),
    targets: await okJson(await app.request(CRLS), CrlTargetListItem.array()),
  };
}

describe("the lists", () => {
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
  const PATHS = [CERTIFICATES, CRLS, `/api/v1/blobs/${cert("root-ca").sha256}`];

  it("is a 500 envelope on every read, never 200 [] or the exception text", async () => {
    const secret = "private storage details";
    const svc = await readService({
      wrap: (base) => patchStore({ get: () => Promise.reject(new Error(secret)) }, base),
    });
    for (const path of PATHS) {
      await expectInternal(await svc.app.request(path), secret);
      expect(logRecords(svc.deps).at(-2), path).toMatchObject({
        level: "error",
        msg: "unhandled_error",
        path,
      });
    }
  });
});
