// node scripts/seed-dev.ts   (pnpm run seed:dev)
// Seeds a development server through the CLI's main (src/cli/aia.ts): imports the root and both
// issuing CA certificates of tests/fixtures/pki, then, unless a configuration exists, applies one
// with fresh target ids that serves them under /ca/<name>.crt, /crl/<name>.crl and
// /dcrl/issuing-ca-{1,2}.crl, and publishes a CRL to every target but issuing-ca-2's delta (CRLS),
// which stays unpublished, so the UI shows that state too.
// Idempotent: a second run reports every certificate and CRL unchanged and leaves the
// configuration alone (pnpm run reset:dev starts over).
//
//   AIA_URL=http://127.0.0.1:8787 AIA_ADMIN_TOKEN=dev-admin-token pnpm run seed:dev
//
// The CRLs go up with the upload token when AIA_UPLOAD_TOKEN is set (the CLI's publish).
//
// Rewrite of worker-aia-cdp@5b570aa:scripts/seed-dev.sh, which wrote R2 objects directly.
import process from "node:process";
import { encodeJson } from "../src/core/catalog.ts";
import type { Config } from "../src/core/catalog.ts";
import { main, processIo } from "../src/cli/aia.ts";
import { fixturePath, manifest } from "../tests/fixtures/pki.ts";

interface Ca {
  name: string;
  label: string;
  /** Also gets a delta CRL target and a /dcrl/ path. */
  delta: boolean;
}

/**
 * One CRL per target but issuing-ca-2's delta: the root's OpenSSL-style CRL (no Next CRL Publish)
 * and issuing-ca-1's AD CS-style pair with two revocations.
 */
const CRLS = [
  "crls/root-ca/full-01.der",
  "crls/issuing-ca-1/full-adcs.der",
  "crls/issuing-ca-1/delta-adcs.der",
  "crls/issuing-ca-2/full-01.der",
];

const CAS: Ca[] = [
  { name: "root-ca", label: "Example Root CA", delta: false },
  { name: "issuing-ca-1", label: "Example Issuing CA 01", delta: true },
  { name: "issuing-ca-2", label: "Example Issuing CA 02", delta: true },
];

/** The certificate id is the SHA-256 of the DER, which the manifest records. */
function certificateId(name: string): string {
  const found = manifest.certificates.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`tests/fixtures/pki/manifest.json has no certificate ${name}`);
  }
  return found.sha256;
}

function seedConfig(): Config {
  const config: Config = { version: 1, certificates: {}, targets: {}, paths: {} };
  for (const ca of CAS) {
    const id = certificateId(ca.name);
    config.certificates[id] = { label: ca.label };
    config.paths[`/ca/${ca.name}.crt`] = { certificate: id };
    const full = crypto.randomUUID();
    config.targets[full] = { issuer: id, kind: "full", label: ca.label };
    config.paths[`/crl/${ca.name}.crl`] = { target: full };
    if (ca.delta) {
      const delta = crypto.randomUUID();
      config.targets[delta] = { issuer: id, kind: "delta", label: `${ca.label} (delta)` };
      config.paths[`/dcrl/${ca.name}.crl`] = { target: delta };
    }
  }
  return config;
}

async function seed(): Promise<number> {
  const io = processIo();

  process.stdout.write("seed-dev: importing certificates\n");
  const imported = await main(
    ["import", ...CAS.map((ca) => fixturePath(`certs/${ca.name}.der`))],
    io
  );
  if (imported !== 0) {
    return imported;
  }

  // `config show --json` prints {"etag": null, "config": null} when nothing is configured yet
  // (and exits 1); any other failure prints nothing on stdout.
  let shown = "";
  let complaint = "";
  const show = await main(["config", "show", "--json"], {
    ...io,
    stdout: (text) => {
      shown += text;
    },
    stderr: (text) => {
      complaint += text;
    },
  });
  if (show === 0) {
    process.stdout.write("seed-dev: config.json exists, not applied (pnpm run reset:dev)\n");
  } else {
    let missing: boolean;
    try {
      missing = (JSON.parse(shown) as { config?: unknown }).config === null;
    } catch {
      missing = false;
    }
    if (!missing) {
      process.stderr.write(complaint);
      return show;
    }

    // Applied through the CLI as a file would be; the generated document never touches the disk.
    const generated = "<seed-dev config>";
    const bytes = encodeJson(seedConfig());
    process.stdout.write("seed-dev: applying a configuration\n");
    const applied = await main(["config", "apply", generated], {
      ...io,
      readFile: (path) => (path === generated ? Promise.resolve(bytes) : io.readFile(path)),
    });
    if (applied !== 0) {
      return applied;
    }
  }

  process.stdout.write("seed-dev: publishing CRLs\n");
  return main(["publish", ...CRLS.map((file) => fixturePath(file))], io);
}

process.exitCode = await seed();
