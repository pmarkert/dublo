// Copies the authored skill from .claude/skills into resources/skills so it
// ships in the npm package (resources is in the package `files` allowlist; the
// .claude directory is not). Run by `npm run build`, so it happens before both
// `prepare` (git installs) and `prepack` (publish). resources/skills is a build
// artifact and is gitignored.
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".claude", "skills", "dublo");
const destinationParent = path.join(root, "resources", "skills");
const destination = path.join(destinationParent, "dublo");

if (!existsSync(source)) {
  process.stderr.write(`sync-skill: skill source not found at ${source}\n`);
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destinationParent, { recursive: true });
await cp(source, destination, { recursive: true });
process.stdout.write(`sync-skill: ${path.relative(root, destination)}\n`);
