import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./pki/", import.meta.url));

export interface Manifest {
  now: string;
  [key: string]: unknown;
}

export const manifest = JSON.parse(readFileSync(`${root}manifest.json`, "utf8")) as Manifest;

export const NOW = new Date(manifest.now);

export function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(`${root}${path}`));
}
