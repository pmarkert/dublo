import path from "node:path";
import process from "node:process";
import { listContextProfileNames, resolveWorkspacePath } from "./shared.js";

export async function listContextCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const names = listContextProfileNames(workspacePath);

  if (names.length === 0) {
    process.stdout.write(`No context profiles found under ${path.join(workspacePath, "context")}.\n`);
    return;
  }

  process.stdout.write(`Workspace context profiles in ${path.join(workspacePath, "context")}:\n`);
  for (const name of names) {
    process.stdout.write(`- ${name}\n`);
  }
}
