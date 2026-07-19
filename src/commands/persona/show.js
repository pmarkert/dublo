import process from "node:process";
import { loadScenarioConfig } from "../../config/loadScenarioConfig.js";
import { inferSinglePersonaProfile, readPersonaText, resolvePersonaProfilePath, resolveWorkspacePath } from "./shared.js";

export async function showPersonaCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const config = loadScenarioConfig({ workspace: options.workspace, persona: options.profile || options.name });
  const selected = firstDefined(config.persona, config.workspacePersonaRef, inferSinglePersonaProfile(workspacePath));

  if (!selected) {
    throw new Error("No persona profile selected. Pass a profile name or set persona in workspace config/env.");
  }

  const profilePath = resolvePersonaProfilePath(workspacePath, selected);
  if (!profilePath) {
    throw new Error(`Could not resolve persona profile '${selected}' in the workspace or built-in templates.`);
  }

  const text = await readPersonaText(profilePath);
  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
