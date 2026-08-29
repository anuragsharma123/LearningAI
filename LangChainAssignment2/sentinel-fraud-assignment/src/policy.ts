import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(__dirname, "..", "policy");

/** Reads a policy file by name (no extension). Plain file I/O, not a DB read. */
export function loadPolicyFile(name: string): string {
  return fs.readFileSync(path.join(POLICY_DIR, `${name}.md`), "utf-8");
}
