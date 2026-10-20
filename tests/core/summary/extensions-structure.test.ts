import { expect, it } from "vitest";
import { parseCertificate } from "../../../src/core/pki/parsers.ts";
import { extractPEMBlock } from "../../../src/core/pki/pem.ts";
import { buildTBSCertificate } from "../../../src/core/summary/certificate.ts";
import { fixture } from "../../fixtures/pki.ts";

// worker-aia-cdp@5b570aa:tests/worker/extensions-structure.test.ts on certs/leaf-full.der and
// certs/root-ca.pem; fixture() gives the bytes, so the Buffer copy helpers are gone.

it("certificate metadata exposes structured extension entries", async () => {
  const leafCertificate = parseCertificate(fixture("certs/leaf-full.der"));
  const leafMetadata = await buildTBSCertificate(leafCertificate);

  const caPem = new TextDecoder().decode(fixture("certs/root-ca.pem"));
  const caDer = extractPEMBlock(caPem, "-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----");
  const caCertificate = parseCertificate(caDer);
  const caMetadata = await buildTBSCertificate(caCertificate);

  const allEntries = [
    ...(leafMetadata.extensions?.items ?? []),
    ...(caMetadata.extensions?.items ?? []),
  ];

  expect(Array.isArray(leafMetadata.extensions?.items), "leaf extensions should be an array").toBe(
    true
  );
  expect(Array.isArray(caMetadata.extensions?.items), "CA extensions should be an array").toBe(
    true
  );
  expect(
    allEntries.length,
    "combined extensions should include at least one entry"
  ).toBeGreaterThan(0);

  for (const entry of allEntries) {
    expect(entry.extnID.oid, "each extension entry includes an oid").toBeTruthy();
    expect(["parsed", "unsupported", "error"], "entry status should be normalized").toContain(
      entry.parseStatus
    );
    expect(typeof entry.critical, "critical flag should be boolean").toBe("boolean");
  }

  const ski = allEntries.find((entry) => entry.extnID.oid === "2.5.29.14");
  expect(ski, "subject key identifier extension should be present").toBeDefined();
  expect(ski?.parseStatus).toBe("parsed");
  const skiValue = ski?.parsed as { keyIdentifier?: string } | undefined;
  expect(typeof skiValue?.keyIdentifier).toBe("string");

  const basicConstraints = allEntries.find((entry) => entry.extnID.oid === "2.5.29.19");
  expect(basicConstraints).toBeDefined();
  expect(basicConstraints?.extnID.name).toBe("Basic Constraints");
});
