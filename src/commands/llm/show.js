import process from "node:process";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import { inferSingleLlmProfile, readJsonObject, resolveLlmProfilePath } from "./shared.js";

export async function showLlmCommand(profile, options = {}) {
  const config = loadScenarioConfig({ workspace: options.workspace, llm: profile || options.name });
  const selected = firstDefined(config.llmRef, config.workspaceLlmRef, inferSingleLlmProfile(config.workspace));

  if (!selected) {
    throw new Error("No llm profile selected. Pass a profile name/path or set llm in workspace config/env.");
  }

  const profilePath = resolveLlmProfilePath(config.workspace, selected);
  if (!profilePath) {
    throw new Error(`Could not resolve llm profile '${selected}'.`);
  }

  const parsed = await readJsonObject(profilePath, "llm profile");
  process.stdout.write(`${JSON.stringify({ profilePath, profile: parsed }, null, 2)}\n`);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
