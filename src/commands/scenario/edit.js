import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runEditor } from "../../utils/editor.js";
import {
  defaultScenarioProfilePath,
  readScenarioText,
  resolveBuiltinScenarioTemplatePath,
  resolveWorkspacePath,
  resolveWorkspaceScenarioProfilePath,
  sanitizeScenarioProfileName
} from "./shared.js";

export async function editScenarioCommand(options = {}) {
  const rawName = String(options.profile || options.name || "").trim();
  if (!rawName) {
    throw new Error("Scenario profile name is required. Pass a profile name.");
  }

  const workspacePath = resolveWorkspacePath(options.workspace);
  const scenarioDir = path.join(workspacePath, "scenarios");
  await mkdir(scenarioDir, { recursive: true });

  const workspaceProfilePath = defaultScenarioProfilePath(workspacePath, sanitizeScenarioProfileName(rawName));
  const existingProfilePath = resolveWorkspaceScenarioProfilePath(workspacePath, rawName);
  const builtinTemplatePath = resolveBuiltinScenarioTemplatePath(rawName);
  const profilePath = existingProfilePath || workspaceProfilePath;

  if (!process.stdin.isTTY) {
    let body = "";
    for await (const chunk of process.stdin) {
      body += String(chunk);
    }
    await writeFile(profilePath, body, "utf8");
    process.stdout.write(`Wrote ${profilePath}\n`);
    return;
  }

  if (!existsSync(profilePath)) {
    const initialText = builtinTemplatePath ? await readScenarioText(builtinTemplatePath) : "";
    await writeFile(profilePath, initialText, "utf8");
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = runEditor(editor, profilePath);

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}
