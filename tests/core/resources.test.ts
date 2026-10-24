import { describe, expect, it } from "vitest";
import { downloadHeaders, resolveDownload } from "../../src/core/resources.ts";
import type { DownloadResolution, FoundDownload } from "../../src/core/resources.ts";
import { cert, NOW } from "../fixtures/pki.ts";
import { buildDownloadSeed, DOWNLOAD_PATHS } from "../helpers/seed-downloads.ts";

// resolveDownload and downloadHeaders where the routes cannot steer them: documents that do not
// back a path, and the edges of the CRL max-age. Everything a request reaches is
// tests/http/downloads.test.ts.

const HOUR = 3_600_000;
const ROOT = cert("root-ca");
const { config, catalog, targets } = await buildDownloadSeed();

function found(resolution: DownloadResolution): FoundDownload {
  if (resolution.status !== "found") {
    throw new Error(`expected found, got ${JSON.stringify(resolution)}`);
  }
  return resolution;
}

describe("resolveDownload", () => {
  it("reports a path entry the catalog or config.targets cannot back as inconsistent", () => {
    const { [ROOT.sha256]: _root, ...certificates } = catalog.certificates;
    expect(
      resolveDownload(config, { ...catalog, certificates }, `${DOWNLOAD_PATHS.root}.pem`)
    ).toEqual({ status: "inconsistent", reference: { certificate: ROOT.sha256 } });
    // The catalog still holds a current CRL for it; the configuration no longer defines it.
    const { [targets.full]: _full, ...rest } = config.targets;
    expect(resolveDownload({ ...config, targets: rest }, catalog, DOWNLOAD_PATHS.full)).toEqual({
      status: "inconsistent",
      reference: { target: targets.full },
    });
  });
});

it("counts a CRL's max-age in whole seconds until nextUpdate, within [60, 3600], 300 without", () => {
  const download = found(resolveDownload(config, catalog, DOWNLOAD_PATHS.full));
  const maxAge = (seconds: number) => `public, max-age=${seconds}, must-revalidate`;
  const nextUpdate = download.nextUpdate?.getTime() ?? Number.NaN;
  const cases: [msBefore: number, seconds: number][] = [
    [-HOUR, 60],
    [0, 60],
    [60_999, 60],
    [61_000, 61],
    [1_234_900, 1234],
    [3_600_000, 3600],
    [3_601_000, 3600],
  ];
  for (const [ms, seconds] of cases) {
    const now = new Date(nextUpdate - ms);
    expect(downloadHeaders(download, now)["Cache-Control"], `${ms} ms`).toBe(maxAge(seconds));
  }
  expect(downloadHeaders({ ...download, nextUpdate: null }, NOW)["Cache-Control"]).toBe(
    maxAge(300)
  );
});
