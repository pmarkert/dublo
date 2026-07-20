import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { createInquirerConfigPrompts, runConfigWizard } from "./config-wizard.js";
import { resolveWorkspaceConfig } from "../core/config/resolve.js";
import { WorkspaceDefaultsPatchSchema, WorkspaceDefaultsSchema } from "../core/config/schemas.js";
import type { WorkspaceDefaults, WorkspaceDefaultsPatch } from "../core/config/schemas.js";
import { createWorkspaceStore } from "../node/workspace-store.js";

const DEFAULT_WORKSPACE_PROMPT = `# Application Notes

Use this file to capture background knowledge, application quirks, test account notes, special commands, and workspace-specific testing instructions for Dublo.
`;

interface WorkspaceOptions {
  workspace?: string;
}

interface FormatOptions extends WorkspaceOptions {
  format?: string;
}

interface InitOptions extends WorkspaceOptions {
  yes?: boolean;
  force?: boolean;
  baseUrl?: string;
  llm?: string;
}

interface ShowOptions extends FormatOptions {
  effective?: boolean;
}

interface EditOptions extends WorkspaceOptions {
  yes?: boolean;
}

function resolveWorkspace(options: WorkspaceOptions): string {
  return createWorkspaceStore().resolve(
    options.workspace ?? process.env.DUBLO_WORKSPACE ?? ".dublo"
  );
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeTextConfig(defaults: WorkspaceDefaults): void {
  const entries = Object.entries(defaults);
  if (entries.length === 0) {
    process.stdout.write("No persisted workspace defaults.\n");
    return;
  }

  for (const [key, value] of entries) {
    process.stdout.write(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}\n`);
  }
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected a boolean value, received '${value}'.`);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received '${value}'.`);
  }
  return parsed;
}

function parseSetting(setting: string, value: string): WorkspaceDefaultsPatch {
  switch (setting) {
    case "base-url":
      return WorkspaceDefaultsPatchSchema.parse({ baseUrl: value });
    case "llm":
      return WorkspaceDefaultsPatchSchema.parse({ llm: value });
    case "persona":
      return WorkspaceDefaultsPatchSchema.parse({ persona: value });
    case "max-steps":
      return WorkspaceDefaultsPatchSchema.parse({ maxSteps: parsePositiveInteger(value) });
    case "headless":
      return WorkspaceDefaultsPatchSchema.parse({ headless: parseBoolean(value) });
    case "screenshots":
      return WorkspaceDefaultsPatchSchema.parse({ screenshots: value });
    case "debug":
      return WorkspaceDefaultsPatchSchema.parse({ debug: parseBoolean(value) });
    case "output-dir":
      return WorkspaceDefaultsPatchSchema.parse({ outputDir: value });
    case "observation-config":
      return WorkspaceDefaultsPatchSchema.parse({ observationConfigFile: value });
    default:
      throw new Error(
        `Unknown setting '${setting}'. Available settings: base-url, llm, persona, max-steps, headless, screenshots, debug, output-dir, observation-config.`
      );
  }
}

const SETTING_KEYS = {
  "base-url": "baseUrl",
  llm: "llm",
  persona: "persona",
  "max-steps": "maxSteps",
  headless: "headless",
  screenshots: "screenshots",
  debug: "debug",
  "output-dir": "outputDir",
  "observation-config": "observationConfigFile"
} as const;

async function readStandardInput(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input;
}

async function editJsonDocument(
  workspace: string,
  defaults: WorkspaceDefaults
): Promise<WorkspaceDefaults> {
  if (!process.stdin.isTTY) {
    return WorkspaceDefaultsSchema.parse(JSON.parse(await readStandardInput()));
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  const temporaryPath = path.join(temporaryDirectory, "defaults.json");
  await writeFile(temporaryPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");

  try {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const result = spawnSync(editor, [temporaryPath], { shell: true, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Editor exited with status ${String(result.status)}.`);
    return WorkspaceDefaultsSchema.parse(JSON.parse(await readFile(temporaryPath, "utf8")));
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function editPromptDocument(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return readStandardInput();
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dublo-prompt-"));
  const temporaryPath = path.join(temporaryDirectory, "prompt.md");
  await writeFile(temporaryPath, prompt, "utf8");

  try {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const result = spawnSync(editor, [temporaryPath], { shell: true, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Editor exited with status ${String(result.status)}.`);
    return readFile(temporaryPath, "utf8");
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runInteractiveWorkspaceConfiguration(
  current: WorkspaceDefaults
): Promise<WorkspaceDefaults | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive configuration requires a terminal. Use --yes with explicit options instead."
    );
  }

  return runConfigWizard({
    current,
    prompts: createInquirerConfigPrompts(),
    write: (text) => process.stdout.write(text)
  });
}

export function registerConfigCommands(program: Command): void {
  program
    .command("init")
    .description("Create a workspace and configure its defaults")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--base-url <url>", "Initial base URL")
    .option("--llm <name>", "Initial default LLM profile")
    .option("--force", "Replace an existing defaults.json")
    .option("-y, --yes", "Create from supplied options without interactive prompts")
    .action(async (options: InitOptions) => {
      const store = createWorkspaceStore();
      const workspace = resolveWorkspace(options);
      const defaultsPath = path.join(workspace, "defaults.json");
      if (existsSync(defaultsPath) && !options.force) {
        throw new Error(
          `Workspace defaults already exist at '${defaultsPath}'. Use config commands to update it or pass --force.`
        );
      }

      await store.ensure(workspace);
      const initial = WorkspaceDefaultsSchema.parse({
        ...(await store.readDefaults(workspace)),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.llm ? { llm: options.llm } : {})
      });
      const defaults = options.yes ? initial : await runInteractiveWorkspaceConfiguration(initial);
      if (defaults === undefined) {
        process.stdout.write("Canceled. No workspace defaults were changed.\n");
        return;
      }
      await store.writeDefaults(workspace, defaults);
      process.stdout.write(`Initialized workspace at ${workspace}\n`);
    });

  const config = program
    .command("config")
    .description("Inspect and update workspace defaults")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)");
  config.addHelpText(
    "after",
    "\nRun 'dublo config' without a subcommand to configure defaults interactively.\n"
  );
  config.action(async (options: WorkspaceOptions) => {
    const store = createWorkspaceStore();
    const workspace = resolveWorkspace(options);
    const defaults = await runInteractiveWorkspaceConfiguration(
      await store.readDefaults(workspace)
    );
    if (defaults === undefined) {
      process.stdout.write("Canceled. No workspace defaults were changed.\n");
      return;
    }
    await store.writeDefaults(workspace, defaults);
    process.stdout.write(`Updated ${path.join(workspace, "defaults.json")}\n`);
  });

  config
    .command("show")
    .description("Show persisted workspace defaults")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--effective", "Include environment and built-in defaults with their sources")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (options: ShowOptions) => {
      const format: string = options.format ?? "text";
      if (format !== "text" && format !== "json")
        throw new Error(`Unknown format '${format}'. Use text or json.`);

      const store = createWorkspaceStore();
      const defaults = await store.readDefaults(resolveWorkspace(options));
      if (options.effective) {
        const resolved = resolveWorkspaceConfig({ environment: process.env, workspace: defaults });
        if (format === "json") writeJson(resolved);
        else {
          for (const [key, value] of Object.entries(resolved.values)) {
            process.stdout.write(
              `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)} (${resolved.sources[key as keyof typeof resolved.sources]})\n`
            );
          }
        }
        return;
      }

      if (format === "json") writeJson(defaults);
      else writeTextConfig(defaults);
    });

  config
    .command("validate")
    .description("Validate persisted workspace defaults")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (options: FormatOptions) => {
      const defaults = await createWorkspaceStore().readDefaults(resolveWorkspace(options));
      if (options.format === "json") writeJson({ valid: true, defaults });
      else process.stdout.write("Workspace defaults are valid.\n");
    });

  config
    .command("edit")
    .description("Edit the complete defaults.json document")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options: EditOptions) => {
      const store = createWorkspaceStore();
      const workspace = resolveWorkspace(options);
      await store.writeDefaults(
        workspace,
        await editJsonDocument(workspace, await store.readDefaults(workspace))
      );
      process.stdout.write(`Updated ${path.join(workspace, "defaults.json")}\n`);
    });

  config
    .command("set <setting> <value>")
    .description("Set one scalar workspace default")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (setting: string, value: string, options: WorkspaceOptions) => {
      const store = createWorkspaceStore();
      const workspace = resolveWorkspace(options);
      const next = WorkspaceDefaultsSchema.parse({
        ...(await store.readDefaults(workspace)),
        ...parseSetting(setting, value)
      });
      await store.writeDefaults(workspace, next);
      const key = SETTING_KEYS[setting as keyof typeof SETTING_KEYS];
      process.stdout.write(`${key}: ${String(next[key])}\n`);
    });

  config
    .command("unset <setting>")
    .description("Remove one scalar workspace default")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (setting: string, options: WorkspaceOptions) => {
      const key = SETTING_KEYS[setting as keyof typeof SETTING_KEYS];
      if (!key) throw new Error(`Unknown or collection setting '${setting}'.`);
      const store = createWorkspaceStore();
      const workspace = resolveWorkspace(options);
      const next: Record<string, unknown> = { ...(await store.readDefaults(workspace)) };
      delete next[key];
      await store.writeDefaults(workspace, WorkspaceDefaultsSchema.parse(next));
      process.stdout.write(`Removed ${key}\n`);
    });

  registerCollectionCommands(config, "context", "context", "context profile");
  registerCollectionCommands(config, "report", "reports", "report renderer");

  const prompt = config.command("prompt").description("Manage workspace prompt.md");
  prompt
    .command("show")
    .description("Write the workspace prompt to stdout")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options: WorkspaceOptions) => {
      const promptText = await createWorkspaceStore().readPrompt(resolveWorkspace(options));
      if (promptText === undefined) throw new Error("Workspace prompt does not exist.");
      process.stdout.write(promptText.endsWith("\n") ? promptText : `${promptText}\n`);
    });
  prompt
    .command("edit")
    .description("Edit the workspace prompt")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options: WorkspaceOptions) => {
      const store = createWorkspaceStore();
      const workspace = resolveWorkspace(options);
      await store.writePrompt(
        workspace,
        await editPromptDocument((await store.readPrompt(workspace)) ?? DEFAULT_WORKSPACE_PROMPT)
      );
      process.stdout.write(`Updated ${path.join(workspace, "prompt.md")}\n`);
    });
}

function registerCollectionCommands(
  config: Command,
  commandName: "context" | "report",
  key: "context" | "reports",
  valueLabel: string
): void {
  const collection = config.command(commandName).description(`Manage default ${valueLabel}s`);
  collection
    .command("add <value>")
    .description(`Add a ${valueLabel}`)
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (value: string, options: WorkspaceOptions) =>
      updateCollection(key, value, "add", options)
    );
  collection
    .command("remove <value>")
    .description(`Remove a ${valueLabel}`)
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (value: string, options: WorkspaceOptions) =>
      updateCollection(key, value, "remove", options)
    );
  collection
    .command("clear")
    .description(`Clear all default ${valueLabel}s`)
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options: WorkspaceOptions) => updateCollection(key, "", "clear", options));
}

async function updateCollection(
  key: "context" | "reports",
  value: string,
  operation: "add" | "remove" | "clear",
  options: WorkspaceOptions
): Promise<void> {
  const store = createWorkspaceStore();
  const workspace = resolveWorkspace(options);
  const defaults = await store.readDefaults(workspace);
  const current = defaults[key] ?? [];
  const next =
    operation === "add"
      ? [...current, value]
      : operation === "remove"
        ? current.filter((entry) => entry !== value)
        : [];
  await store.writeDefaults(workspace, WorkspaceDefaultsSchema.parse({ ...defaults, [key]: next }));
  process.stdout.write(`${key}: ${next.join(", ")}\n`);
}
