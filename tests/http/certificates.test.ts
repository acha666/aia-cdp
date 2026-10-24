// GET /api/v1/certificates and /api/v1/certificates/{id}: the list and detail bodies against the
// HTTP schemas, the id parameter (any case; anything but 64 hex digits is a 400), 404 and the 500
// of a blob the store lost.
import { describe, expect, it } from "vitest";
import { certificateBlobKey, readState } from "../../src/core/catalog.ts";
import { parseCertificate } from "../../src/core/pki/parsers.ts";
import { buildTBSCertificate } from "../../src/core/summary/certificate.ts";
import { CertificateDetail, CertificateListItem } from "../../src/http/schemas.ts";
import { cert, fixture, manifest, NOW } from "../fixtures/pki.ts";
import { logRecords } from "../helpers/app.ts";
import { IMPORTED } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { errorOf, expectInternal, okJson, readService } from "../helpers/reads.ts";

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
  it("lists every imported certificate in id order with label, summary, downloads and targets", async () => {
    const service = await readService({ setup: SERVED });
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
});

describe("GET /api/v1/certificates/{id}", () => {
  it("is the list item plus fingerprints, TBSCertificate and the signature", async () => {
    const service = await readService({ setup: SERVED });
    const root = cert(ROOT);
    const detail = await okJson(await service.app.request(detailPath(ROOT)), CertificateDetail);
    const items = await okJson(await service.app.request(LIST), CertificateListItem.array());
    const item = items.find((each) => each.id === root.sha256);
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
    // ECDSA signatures are random: (r, s) at most 96 hex digits, no leading 00.
    for (const part of [detail.signatureValue.parsed?.r, detail.signatureValue.parsed?.s]) {
      expect(part).toMatch(/^[0-9A-Fa-f]{1,96}$/);
      expect(part).not.toMatch(/^00/);
    }
  });

  it("answers a schema-valid detail for every fixture certificate (leaves with rich extensions too)", async () => {
    const names = manifest.certificates.map((each) => each.name);
    const service = await readService({ setup: { certificates: names, targets: [] } });
    for (const name of names) {
      const body = await okJson(await service.app.request(detailPath(name)));
      expect(CertificateDetail.parse(body), name).toEqual(body);
    }
  });

  it("normalises an uppercase or mixed-case id to the lowercase catalog id", async () => {
    const service = await readService();
    const id = cert(ISSUING).sha256;
    const lower = await okJson(await service.app.request(`${LIST}/${id}`));
    const mixed = `${id.slice(0, 32).toUpperCase()}${id.slice(32)}`;
    for (const variant of [id.toUpperCase(), mixed]) {
      expect(await okJson(await service.app.request(`${LIST}/${variant}`))).toEqual(lower);
    }
  });

  it.each([
    ["not hex", "z".repeat(64)],
    ["63 digits", "a".repeat(63)],
    ["the DER file name", `${"a".repeat(64)}.der`],
    ["a nested id", "nested%2Froot.crt"],
    ["a malformed escape", "%ZZ"],
  ])("rejects %s with 400 bad_request", async (_case, id) => {
    const service = await readService();
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 400, "bad_request");
    expect(error.details).toMatchObject({ target: "param" });
  });

  it("answers 404 for a well-formed id that was never imported", async () => {
    const service = await readService({ setup: { certificates: [ROOT], targets: [] } });
    const id = cert(ISSUING).sha256;
    const error = await errorOf(await service.app.request(`${LIST}/${id}`), 404, "not_found");
    expect(error.message).not.toContain(id);
  });

  it("answers 500 for a catalog certificate whose blob is gone, without leaking the key", async () => {
    const service = await readService();
    const key = certificateBlobKey(cert(ROOT).sha256);
    await service.base.delete(key);
    await expectInternal(await service.app.request(detailPath(ROOT)), key);
    expect(logRecords(service.deps).at(-2)).toMatchObject({
      msg: "unhandled_error",
      error: { message: `The store has no blob ${key}` },
    });
  });
});
