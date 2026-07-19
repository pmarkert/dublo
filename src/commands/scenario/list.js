import path from "node:path";
import process from "node:process";
import { listBuiltinScenarioTemplateNames, listScenarioProfileNames, resolveWorkspacePath } from "./shared.js";

export async function listScenarioCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const names = listScenarioProfileNames(workspacePath);
  const builtinNames = listBuiltinScenarioTemplateNames();

  if (names.length === 0 && builtinNames.length === 0) {
    process.stdout.write(`No scenario profiles found under ${path.join(workspacePath, "scenarios")} and no built-in templates are available.\n`);
    return;
  }

  if (names.length > 0) {
    process.stdout.write(`Workspace scenario profiles in ${path.join(workspacePath, "scenarios")}:\n`);
    for (const name of names) {
      process.stdout.write(`- ${name}\n`);
    }
  }

  if (builtinNames.length > 0) {
    if (names.length > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write("Built-in scenario templates:\n");
    for (const name of builtinNames) {
      process.stdout.write(`- ${name}\n`);
    }
  }
}
