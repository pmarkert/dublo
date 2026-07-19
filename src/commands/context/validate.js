import process from "node:process";
import { inferSingleContextProfile, listContextProfileNames, readContextObject, resolveContextProfilePath, resolveWorkspacePath } from "./shared.js";

export async function validateContextCommand(profile, options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const target = profile || options.name || inferSingleContextProfile(workspacePath);

  const targets = target ? [target] : listContextProfileNames(workspacePath);
  if (targets.length === 0) {
    throw new Error("No context profiles found to validate.");
  }

  let hasErrors = false;
  for (const entry of targets) {
    const profilePath = resolveContextProfilePath(workspacePath, entry);
    if (!profilePath) {
      process.stdout.write(`FAIL ${entry}: profile could not be resolved\n`);
      hasErrors = true;
      continue;
    }

    try {
      await readContextObject(profilePath);
      process.stdout.write(`OK   ${entry} (${profilePath})\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stdout.write(`FAIL ${entry}: ${detail}\n`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    throw new Error("One or more context profiles are invalid.");
  }
}
