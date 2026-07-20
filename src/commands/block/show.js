import process from "node:process";
import { readBlock, resolveBlockPath, resolveWorkspacePath } from "./shared.js";

export async function showBlockCommand(name, options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const blockPath = resolveBlockPath(workspacePath, name);
  if (!blockPath) {
    throw new Error(`Could not resolve block '${name}' in ${workspacePath}.`);
  }

  const block = await readBlock(blockPath);
  process.stdout.write(`File: ${blockPath}\n--\n${JSON.stringify(block, null, 2)}\n`);
}