// GET /api/v1/certificates: the list body against the HTTP schema.
import { expect, it } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import { CertificateListItem } from "../../src/http/schemas.ts";
import { cert, fixture, NOW } from "../fixtures/pki.ts";
import { IMPORTED } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { okJson, readService } from "../helpers/reads.ts";

const LIST = "/api/v1/certificates";
const ROOT = "root-ca";
const ISSUING = "issuing-ca-1";
const ROOT_LABEL = "Example Root CA";

/** The root labelled and served under two paths (the alias sorts first: "-" < "."). */
const SERVED: SetupOptions = {
  configure: (config) => {
    const root = cert(ROOT).sha256;
    config.certificates[root] = { label: ROOT_LABEL };
    config.paths["/ca/root-ca.crt"] = { certificate: root };
    config.paths["/ca/root-ca-alias.crt"] = { certificate: root };
  },
};

const service = await readService({ setup: SERVED });

it("lists every imported certificate in id order with label, summary, downloads and targets", async () => {
  const { catalog } = await readState(service.base);
  const items = await okJson(await service.app.request(LIST), CertificateListItem.array());
  expect(items.map((item) => item.id)).toEqual(IMPORTED.map((name) => cert(name).sha256).sort());

  const root = cert(ROOT);
  expect(items.find((item) => item.id === root.sha256)).toEqual({
    id: root.sha256,
    label: ROOT_LABEL,
    importedAt: NOW.toISOString(),
    size: fixture(root.der).byteLength,
    summary: catalog.certificates[root.sha256]?.summary,
    downloads: [
      "/ca/root-ca-alias.crt",
      "/ca/root-ca-alias.crt.pem",
      "/ca/root-ca.crt",
      "/ca/root-ca.crt.pem",
    ],
    targets: [
      { targetId: service.setup.target(ROOT, "full"), kind: "full", label: `${ROOT} full` },
    ],
  });
  const issuing = items.find((item) => item.id === cert(ISSUING).sha256);
  expect(issuing).toMatchObject({ label: null, downloads: [] });
  // Both of issuing-ca-1's targets, in targetId order.
  const targets = [
    { targetId: service.setup.target(ISSUING, "full"), kind: "full", label: `${ISSUING} full` },
    {
      targetId: service.setup.target(ISSUING, "delta"),
      kind: "delta",
      label: `${ISSUING} delta`,
    },
  ].sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
  expect(issuing?.targets).toEqual(targets);
});
