import process from "node:process";
import { loadScenarioConfig } from "../../config/loadScenarioConfig.js";
import { inferSingleScenarioProfile, readScenarioText, resolveScenarioProfilePath, resolveWorkspacePath } from "./shared.js";

export async function showScenarioCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const config = loadScenarioConfig({ workspace: options.workspace, scenario: options.profile || options.name });
  const selected = firstDefined(config.scenario, inferSingleScenarioProfile(workspacePath));

  if (!selected) {
    throw new Error("No scenario profile selected. Pass a profile name.");
  }

  const profilePath = resolveScenarioProfilePath(workspacePath, selected);
  if (!profilePath) {
    throw new Error(`Could not resolve scenario profile '${selected}' in the workspace or built-in templates.`);
  }

  const text = await readScenarioText(profilePath);
  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
