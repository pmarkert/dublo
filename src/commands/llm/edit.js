import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { runEditor } from "../../utils/editor.js";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import { inferSingleLlmProfile, resolveLlmProfilePath } from "./shared.js";

export async function editLlmCommand(profile, options = {}) {
  const config = loadScenarioConfig({ workspace: options.workspace, llm: profile || options.name });
  const selected = firstDefined(config.llmRef, config.workspaceLlmRef, inferSingleLlmProfile(config.workspace));

  if (!selected) {
    throw new Error("No llm profile selected. Pass a profile name/path or set llm in workspace config/env.");
  }

  const profilePath = resolveLlmProfilePath(config.workspace, selected);
  if (!profilePath || !existsSync(profilePath)) {
    throw new Error(`Could not resolve llm profile '${selected}'.`);
  }

  if (!process.stdin.isTTY) {
    let body = "";
    for await (const chunk of process.stdin) {
      body += String(chunk);
    }
    await writeFile(profilePath, body, "utf8");
    process.stdout.write(`Wrote ${profilePath}\n`);
    return;
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = runEditor(editor, profilePath);
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}