// Guarded `prepare` hook.
//
// `prepare` runs on `npm install` in a checkout AND when someone installs
// dublo straight from git (`npm i -g github:pmarkert/dublo#branch`). Building
// there needs the TypeScript toolchain (`typescript`, `@types/node`), which
// npm normally installs for the git `prepare` step. In a network-restricted
// sandbox that nested install is blocked, so a plain `tsc` would die with a
// cryptic `TS2591: Cannot find name 'process' ... install @types/node`.
//
// This script builds when the toolchain is present (dev checkouts, publish,
// and unrestricted git installs) and otherwise exits with an actionable
// message pointing at the reliable install paths (published/packed tarball),
// instead of the confusing compiler error. If a prebuilt dist/ happens to be
// present it is used as-is.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function toolchainAvailable() {
  try {
    require.resolve("typescript");
    return true;
  } catch {
    return false;
  }
}

if (toolchainAvailable()) {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  process.exit(result.status ?? 1);
}

const prebuilt = existsSync(path.join(root, "dist", "cli.js"));
if (prebuilt) {
  process.stdout.write(
    "prepare: TypeScript toolchain not found; using the committed dist/ build.\n"
  );
  process.exit(0);
}

process.stderr.write(
  "prepare: TypeScript toolchain not found and no committed dist/ build is present.\n" +
    "Install devDependencies and run `npm run build`, or install a published/packed dublo.\n"
);
process.exit(1);
