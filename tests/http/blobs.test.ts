// GET /api/v1/blobs/{sha256}: the DER of an imported certificate or of a configured target's
// current CRL as stored, never a superseded version; the SHA-256 parameter (any case; anything but
// 64 hex digits is a 400), 404 and the 500 of a blob the store lost.
import { expect, it } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import { cert, crlEntry, fixture } from "../fixtures/pki.ts";
import { errorOf, expectInternal, readService } from "../helpers/reads.ts";

const BLOBS = "/api/v1/blobs";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";

/** issuing-ca-1's full target: full-01, then full-02 as its current CRL. */
const service = await readService({ publish: [FULL_01, FULL_02] });

async function expectDer(res: Response, contentType: string, der: Uint8Array) {
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe(contentType);
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(der);
}

it("serves an imported certificate as application/pkix-cert, its id in either case", async () => {
  const root = cert("root-ca");
  for (const id of [root.sha256, root.sha256.toUpperCase()]) {
    await expectDer(
      await service.app.request(`${BLOBS}/${id}`),
      "application/pkix-cert",
      fixture(root.der)
    );
  }
});

it("serves a current CRL as application/pkix-crl, but not the version it replaced", async () => {
  const current = crlEntry(FULL_02).sha256;
  await expectDer(
    await service.app.request(`${BLOBS}/${current}`),
    "application/pkix-crl",
    fixture(FULL_02)
  );
  const replaced = crlEntry(FULL_01).sha256;
  await errorOf(await service.app.request(`${BLOBS}/${replaced}`), 404, "not_found");
});

it.each([
  ["not hex", "z".repeat(64)],
  ["63 digits", "a".repeat(63)],
  ["the DER file name", `${"a".repeat(64)}.der`],
  ["a malformed escape", "%ZZ"],
])("rejects %s with 400 bad_request", async (_case, sha256) => {
  const error = await errorOf(await service.app.request(`${BLOBS}/${sha256}`), 400, "bad_request");
  expect(error.details).toMatchObject({ target: "param" });
});

it("answers 404 for a certificate that was never imported", async () => {
  const id = cert("leaf-min").sha256;
  await errorOf(await service.app.request(`${BLOBS}/${id}`), 404, "not_found");
});

it("answers 500 for a current CRL whose blob is gone, without leaking the key", async () => {
  const own = await readService({ publish: [FULL_01] });
  const target = own.setup.target("issuing-ca-1", "full");
  const key = (await readState(own.base)).catalog.targets[target]?.current?.key ?? "";
  await own.base.delete(key);
  await expectInternal(await own.app.request(`${BLOBS}/${crlEntry(FULL_01).sha256}`), key);
});
