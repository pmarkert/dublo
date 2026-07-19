import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { listBuiltinPersonaTemplateNames, listPersonaProfileNames, resolveWorkspacePath } from "./shared.js";

export async function listPersonaCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const names = listPersonaProfileNames(workspacePath);
  const builtinNames = listBuiltinPersonaTemplateNames();
  const workspaceDefault = await readWorkspaceDefault(workspacePath);
  const envDefault = process.env.DUBLO_PERSONA || "";

  if (names.length === 0 && builtinNames.length === 0) {
    process.stdout.write(`No persona profiles found under ${path.join(workspacePath, "personas")} and no built-in templates are available.\n`);
    return;
  }

  if (names.length > 0) {
    process.stdout.write(`Workspace persona profiles in ${path.join(workspacePath, "personas")}:\n`);
    for (const name of names) {
      const markers = [];
      if (workspaceDefault && workspaceDefault === name) markers.push("workspace-default");
      if (envDefault && envDefault === name) markers.push("env-default");
      const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
      process.stdout.write(`- ${name}${suffix}\n`);
    }
  }

  if (builtinNames.length > 0) {
    if (names.length > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write("Built-in persona templates:\n");
    for (const name of builtinNames) {
      process.stdout.write(`- ${name}\n`);
    }
  }
}

async function readWorkspaceDefault(workspacePath) {
  const configPath = path.join(workspacePath, "defaults.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return typeof parsed.persona === "string" ? parsed.persona : "";
    }
  } catch {
    return "";
  }

  return "";
}
