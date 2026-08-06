import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WorkspaceDefaultsSchema } from "../../core/config/schemas.js";
import {
  createInquirerConfigPrompts,
  runConfigWizard
} from "../../cli/config-wizard.js";
import { listWorkspaceProfileChoices } from "../../cli/config-commands.js";
import { runEditor } from "../../utils/editor.js";
import {
  defaultTestConfigPath,
  resolveWorkspacePath,
  resolveWorkspaceScenarioProfilePath
} from "./shared.js";

function resolveConfigPath(options) {
  const profile = String(options.profile || options.name || "").trim();
  if (!profile) throw new Error("Test profile name is required. Pass a profile name.");
  const workspacePath = resolveWorkspacePath(options.workspace);
  if (!resolveWorkspaceScenarioProfilePath(workspacePath, profile)) {
    throw new Error(`Could not resolve workspace test profile '${profile}'. Create it with 'dublo test edit ${profile}' first.`);
  }
  return defaultTestConfigPath(workspacePath, profile);
}

function parseConfig(content, configPath) {
  try {
    return WorkspaceDefaultsSchema.parse(JSON.parse(content));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid test config at '${configPath}': ${detail}`);
  }
}

async function readStandardInput() {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

async function readWorkspaceDefaults(workspacePath) {
  const defaultsPath = path.join(workspacePath, "defaults.json");
  if (!existsSync(defaultsPath)) return {};
  try {
    return WorkspaceDefaultsSchema.parse(JSON.parse(await readFile(defaultsPath, "utf8")));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid workspace defaults at '${defaultsPath}': ${detail}`);
  }
}

export async function configureTestConfigCommand(options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive test configuration requires a terminal. Use 'dublo test config edit <profile>' to provide JSON from stdin.");
  }

  const configPath = resolveConfigPath(options);
  const workspacePath = resolveWorkspacePath(options.workspace);
  const baseline = await readWorkspaceDefaults(workspacePath);
  const existing = existsSync(configPath)
    ? parseConfig(await readFile(configPath, "utf8"), configPath)
    : {};
  const config = await runConfigWizard({
    current: { ...baseline, ...existing },
    baseline,
    heading: `Dublo test configuration: ${options.profile || options.name}`,
    instructions: "Use the displayed defaults to set overrides for this test only.",
    previewHeading: "Test config overrides to save:",
    savePrompt: "Save these test config overrides",
    profiles: listWorkspaceProfileChoices(workspacePath),
    prompts: createInquirerConfigPrompts(),
    write: (text) => process.stdout.write(text)
  });
  if (config === undefined) {
    process.stdout.write("Canceled. No test config was changed.\n");
    return;
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${configPath}\n`);
}

export async function showTestConfigCommand(options = {}) {
  const configPath = resolveConfigPath(options);
  if (!existsSync(configPath)) {
    throw new Error(`No test config exists at '${configPath}'. Use 'dublo test config edit ${options.profile || options.name}' to create it.`);
  }
  const config = parseConfig(await readFile(configPath, "utf8"), configPath);
  process.stdout.write(`File: ${configPath}\n--\n${JSON.stringify(config, null, 2)}\n`);
}

export async function editTestConfigCommand(options = {}) {
  const configPath = resolveConfigPath(options);
  await mkdir(path.dirname(configPath), { recursive: true });

  let content;
  if (!process.stdin.isTTY) {
    content = await readStandardInput();
  } else {
    if (!existsSync(configPath)) await writeFile(configPath, "{}\n", "utf8");
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = runEditor(editor, configPath);
    if (result.error) throw result.error;
    if (typeof result.status === "number" && result.status !== 0) {
      throw new Error(`Editor exited with status ${result.status}.`);
    }
    content = await readFile(configPath, "utf8");
  }

  const config = parseConfig(content, configPath);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${configPath}\n`);
}

export async function validateTestConfigCommand(options = {}) {
  const configPath = resolveConfigPath(options);
  const config = parseConfig(await readFile(configPath, "utf8"), configPath);
  process.stdout.write(`OK   ${options.profile || options.name} (${configPath})\n`);
  return config;
}