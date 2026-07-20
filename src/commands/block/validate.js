import process from "node:process";
import { listBlockNames, readBlock, resolveBlockPath, resolveWorkspacePath } from "./shared.js";

export async function validateBlockCommand(name, options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const targets = name ? [name] : listBlockNames(workspacePath);
  if (targets.length === 0) {
    throw new Error("No blocks found to validate.");
  }

  let hasErrors = false;
  for (const target of targets) {
    const blockPath = resolveBlockPath(workspacePath, target);
    if (!blockPath) {
      process.stdout.write(`FAIL ${target}: block could not be resolved\n`);
      hasErrors = true;
      continue;
    }

    try {
      await readBlock(blockPath);
      process.stdout.write(`OK   ${target} (${blockPath})\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stdout.write(`FAIL ${target}: ${detail}\n`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    throw new Error("One or more blocks are invalid.");
  }
}