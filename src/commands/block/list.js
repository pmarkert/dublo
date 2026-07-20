import path from "node:path";
import process from "node:process";
import { listBlockNames, resolveWorkspacePath } from "./shared.js";

export async function listBlockCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const names = listBlockNames(workspacePath);
  const blockDir = path.join(workspacePath, "blocks");

  if (names.length === 0) {
    process.stdout.write(`No blocks found under ${blockDir}.\n`);
    return;
  }

  process.stdout.write(`Blocks in ${blockDir}:\n`);
  for (const name of names) {
    process.stdout.write(`- ${name}\n`);
  }
}