// GET /api/v1/certificates and /api/v1/certificates/{id} (implementation slice 5a steps 5–7): the
// list and detail bodies against the HTTP schemas, the targets of §10 #10, the id parameter
// (uppercase normalised; non-hex, nested and archive-style ids rejected, §10 #2), 404, the 500 of a
// blob the store lost (§10 #9), no-store on every status (§10 #17) and HEAD. Migrated:
// worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts case 3, whose nested ids (`nested/
// root.crt`, `nested%2Froot.crt`) the v2 detail served as store keys; an id is the SHA-256 now.
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, certificateBlobKey, CONFIG_KEY } from "../../src/core/catalog.ts";
import { parseCertificate } from "../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../src/core/summary/certificate.ts";
import { CertificateDetail, CertificateListItem } from "../../src/http/schemas.ts";
import { fixture, manifest, NOW } from "../fixtures/pki.ts";
import { logRecords } from "../helpers/app.ts";
import { cert } from "../helpers/catalog.ts";
import { IMPORTED } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import {
  errorOf,
  expectHead,
  expectInternal,
  okJson,
  readService,
  recordReads,
  stateOf,
} from "../helpers/reads.ts";

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

function detailPath(name: string): string {
  return `${LIST}/${cert(name).sha256}`;
}

describe("GET /api/v1/certificates", () => {
  it("lists every imported certificate in id order, each matching CertificateListItem", async () => {
    const service = await readService({ setup: SERVED });
    const body = await okJson(await service.app.request(LIST));
    // parse() drops keys the schema does not know: equal means no store key or v2 field leaked.
    expect(CertificateListItem.array().parse(body)).toEqual(body);
    const items = CertificateListItem.array().parse(body);
    expect(items.map((item) => item.id)).toEqual(IMPORTED.map((name) => cert(name).sha256).sort());
  });

  it("carries label, importedAt, size, the catalog summary, downloads and targets", async () => {
    const service = await readService({ setup: SERVED });
    const { catalog } = await stateOf(service);
    const root = cert(ROOT);
    const items = CertificateListItem.array().parse(await okJson(await service.app.request(LIST)));
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
        {
          targetId: service.setup.target(ROOT, "full"),
          kind: "full",
          label: `${ROOT} full`,
        },
      ],
    });
    const issuing = items.find((item) => item.id === cert(ISSUING).sha256);
    expect(issuing).toMatchObject({ label: null, downloads: [] });
    // Both of issuing-ca-1's targets, in targetId order (§10 #10).
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

  it("reads config.json and catalog.json once each, and no blob", async () => {
    const service = await readService({ wrap: recordReads });
    const store = service.deps.store as ReturnType<typeof recordReads>;
    await okJson(await service.app.request(LIST));
    expect(store.gets.sort()).toEqual([CATALOG_KEY, CONFIG_KEY].sort());
    expect(store.lists).toEqual([]);
  });

  it("answers HEAD with the headers and no body", async () => {
    const service = await readService();
    await expectHead(await service.app.request(LIST, { method: "HEAD" }));
  });
});

describe("GET /api/v1/certificates/{id}", () => {
  it("is the list item plus fingerprints, TBSCertificate and the signature", async () => {
    const service = await readService({ setup: SERVED });
    const root = cert(ROOT);
    const body = await okJson(await service.app.request(detailPath(ROOT)));
    expect(CertificateDetail.parse(body)).toEqual(body);
    const detail = CertificateDetail.parse(body);
    const item = CertificateListItem.array()
      .parse(await okJson(await service.app.request(LIST)))
      .find((each) => each.id === root.sha256);
    expect(detail).toMatchObject(item!);
    expect(detail.fingerprints).toEqual({ sha1: item?.summary.sha1, sha256: root.sha256 });
    const der = fixture(root.der);
    expect(detail.tbsCertificate).toEqual(
      JSON.parse(JSON.stringify(await buildTBSCertificate(parseCertificate(der))))
    );
    expect(detail.tbsCertificate.serialNumber.hex).toBe(root.serial);
    expect(detail.signatureAlgorithm.algorithm).toEqual({
      oid: "1.2.840.10045.4.3.3",
      name: "ecdsa-with-SHA384",
    });
    // ECDSA signatures are random: (r, s) at most 96 hex digits, no leading 00 (slice 5a tests).
    for (const part of [detail.signatureValue.parsed?.r, detail.signatureValue.parsed?.s]) {
      expect(part).toMatch(/^[0-9A-Fa-f]{1,96}$/);
      expect(part).not.toMatch(/^00/);
    }
  });

  it("names the targets the certificate issues for (§10 #10)", async () => {
    const service = await readService();
    const detail = CertificateDetail.parse(
      await okJson(await service.app.request(detailPath(ROOT)))
    );
    expect(detail.targets).toEqual([
      { targetId: service.setup.target(ROOT, "full"), kind: "full", label: `${ROOT} full` },
    ]);
  });

  it("normalises an uppercase or mixed-case id to the lowercase catalog id", async () => {
    const service = await readService();
    const id = cert(ISSUING).sha256;
    const lower = await okJson(await service.app.request(`${LIST}/${id}`));
    const mixed = `${id.slice(0, 32).toUpperCase()}${id.slice(32)}`;
    for (const variant of [id.toUpperCase(), mixed]) {
      const body = await okJson(await service.app.request(`${LIST}/${variant}`));
      expect(body).toEqual(lower);
      expect((body as { id: string }).id).toBe(id);
    }
  });

  it.each([
    ["not hex", "z".repeat(64)],
    ["63 digits", "a".repeat(63)],
    ["65 digits", "a".repeat(65)],
    ["the DER file name", `${"a".repeat(64)}.der`],
    ["a nested id", "nested%2Froot.crt"],
    ["an archive-style id (§10 #2)", "crl%2Farchive%2Fissuing-ca-1.crl"],
    ["a blob key", `blobs%2Fcertificates%2F${"a".repeat(64)}.der`],
    ["a parent segment", "..%2Fcatalog.json"],
    ["unicode", "%C3%A9".repeat(32)],
    ["a malformed escape", "%ZZ"],
  ])("rejects %s with 400 bad_request", async (_case, id) => {
    const service = await readService();
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 400, "bad_request");
    expect(error.details).toMatchObject({ target: "param" });
  });

  it("knows no route for a multi-segment id: a JSON 404, never a store key", async () => {
    const service = await readService();
    const archive = `blobs/certificates/${cert(ROOT).sha256}.der`;
    for (const path of [
      `${LIST}/nested/root.crt`,
      `${LIST}/crl/archive/x.crl`,
      `${LIST}/${archive}`,
    ]) {
      await errorOf(await service.app.request(path), 404, "not_found");
    }
  });

  it("answers 404 for a well-formed id that was never imported", async () => {
    const service = await readService({ setup: { certificates: [ROOT], targets: [] } });
    const id = cert(ISSUING).sha256;
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 404, "not_found");
    expect(error.message).not.toContain(id);
  });

  it("answers 500 for a catalog certificate whose blob is gone, without leaking the key", async () => {
    const service = await readService();
    const id = cert(ROOT).sha256;
    const key = certificateBlobKey(id);
    await service.base.delete(key);
    const res = await service.app.request(`${LIST}/${id}`);
    await expectInternal(res, key, "blob_missing");
    // One line of its own, then the request line.
    const records = logRecords(service.deps).slice(-2);
    expect(records).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "read_inconsistent",
        reason: "blob_missing",
        key,
      }),
      expect.objectContaining({ msg: "request", status: 500 }),
    ]);
  });

  it("answers 500 for a blob with other bytes than the catalog's digest", async () => {
    const service = await readService();
    const key = certificateBlobKey(cert(ROOT).sha256);
    await service.base.put(key, fixture(cert(ISSUING).der));
    await expectInternal(await service.app.request(detailPath(ROOT)), key);
    expect(logRecords(service.deps).at(-2)).toMatchObject({
      msg: "read_inconsistent",
      reason: "blob_mismatch",
      key,
    });
  });

  it("reads config.json and catalog.json once each, then the one blob", async () => {
    const service = await readService({ wrap: recordReads });
    const store = service.deps.store as ReturnType<typeof recordReads>;
    await okJson(await service.app.request(detailPath(ISSUING)));
    expect(store.gets.slice(0, 2).sort()).toEqual([CATALOG_KEY, CONFIG_KEY].sort());
    expect(store.gets.slice(2)).toEqual([certificateBlobKey(cert(ISSUING).sha256)]);
  });

  it("answers HEAD with the headers and no body", async () => {
    const service = await readService();
    await expectHead(await service.app.request(detailPath(ROOT), { method: "HEAD" }));
  });

  it("answers a schema-valid detail for every fixture certificate (leaves with rich extensions too)", async () => {
    const names = manifest.certificates.map((each) => each.name);
    const service = await readService({ setup: { certificates: names, targets: [] } });
    for (const name of names) {
      const body = await okJson(await service.app.request(detailPath(name)));
      expect(CertificateDetail.parse(body), name).toEqual(body);
    }
  });
});
