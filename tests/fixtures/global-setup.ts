import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./generate-test-data.sh", import.meta.url));
const outDir = fileURLToPath(new URL("./pki", import.meta.url));

// The fixtures are committed and tests never rewrite them. Once per vitest process, check that the
// tree still matches the generator (stamp + SHA256SUMS); regenerating is a deliberate step.
export default function setup(): void {
  const run = spawnSync("bash", [script, "--check", outDir], { encoding: "utf8" });
  if (run.status !== 0) {
    const output = run.error?.message ?? (run.stderr || run.stdout).trim();
    throw new Error(
      `tests/fixtures/pki does not match generate-test-data.sh (${output}): ` +
        "run `pnpm run fixtures` and commit the regenerated tree"
    );
  }
}
