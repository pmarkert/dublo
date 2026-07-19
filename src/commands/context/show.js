import process from "node:process";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import { inferSingleContextProfile, readContextObject, resolveContextProfilePath, resolveWorkspacePath } from "./shared.js";

export async function showContextCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const config = loadScenarioConfig({ workspace: options.workspace });

  const fromConfig = Array.isArray(config.contextRefs) && config.contextRefs.length === 1
    ? config.contextRefs[0]
    : Array.isArray(config.workspaceContextRefs) && config.workspaceContextRefs.length === 1
      ? config.workspaceContextRefs[0]
      : "";

  const selected = firstDefined(options.profile, options.name, fromConfig, inferSingleContextProfile(workspacePath));
  if (!selected) {
    throw new Error("No context profile selected. Pass a profile name.");
  }

  const profilePath = resolveContextProfilePath(workspacePath, selected);
  if (!profilePath) {
    throw new Error(`Could not resolve context profile '${selected}' in the workspace.`);
  }

  const object = await readContextObject(profilePath);
  process.stdout.write(`${JSON.stringify(object, null, 2)}\n`);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
