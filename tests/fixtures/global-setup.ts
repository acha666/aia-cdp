import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./generate-test-data.sh", import.meta.url));
const outDir = fileURLToPath(new URL("./pki", import.meta.url));

// Runs once per vitest process; the generator is a no-op when its stamp matches.
export default function setup(): void {
  execFileSync("bash", [script, outDir], { stdio: "inherit" });
}
