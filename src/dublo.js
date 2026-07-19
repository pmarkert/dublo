#!/usr/bin/env node
import tab from "@bomb.sh/tab/commander";
import { Command } from "commander";
import { readdirSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { configureCommand } from "./commands/configure.js";
import { configureLlmCommand } from "./commands/llm/configure.js";
import { listLlmCommand } from "./commands/llm/list.js";
import { showLlmCommand } from "./commands/llm/show.js";
import { validateLlmCommand } from "./commands/llm/validate.js";
import { editPersonaCommand } from "./commands/persona/edit.js";
import { listPersonaCommand } from "./commands/persona/list.js";
import { showPersonaCommand } from "./commands/persona/show.js";
import { editScenarioCommand } from "./commands/scenario/edit.js";
import { listScenarioCommand } from "./commands/scenario/list.js";
import { showScenarioCommand } from "./commands/scenario/show.js";
import { editContextCommand } from "./commands/context/edit.js";
import { listContextCommand } from "./commands/context/list.js";
import { showContextCommand } from "./commands/context/show.js";
import { validateContextCommand } from "./commands/context/validate.js";
import { runCommand } from "./commands/run.js";

const program = new Command();

function currentCompletionToken() {
  const argv = process.argv;
  const doubleDashIndex = argv.indexOf("--");
  if (doubleDashIndex === -1 || doubleDashIndex === argv.length - 1) {
    return "";
  }

  return argv[argv.length - 1] ?? "";
}

function listPathCompletions(complete, options = {}) {
  const token = currentCompletionToken();
  const normalizedToken = token.replace(/\\/g, "/");
  const hasSlash = normalizedToken.includes("/");
  const tokenEndsWithSlash = normalizedToken.endsWith("/");

  const parentPath = tokenEndsWithSlash
    ? normalizedToken.slice(0, -1)
    : hasSlash
      ? normalizedToken.slice(0, normalizedToken.lastIndexOf("/"))
      : "";

  const searchPrefix = tokenEndsWithSlash
    ? ""
    : hasSlash
      ? normalizedToken.slice(normalizedToken.lastIndexOf("/") + 1)
      : normalizedToken;

  const fsParentPath = parentPath || ".";
  const searchDir = isAbsolute(fsParentPath)
    ? resolve(fsParentPath)
    : resolve(process.cwd(), fsParentPath);

  let entries;
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = entry.name;
    if (!entryName.startsWith(searchPrefix)) {
      continue;
    }

    const isDir = entry.isDirectory();
    if (!isDir && options.fileExtensions?.length) {
      const hasAllowedExtension = options.fileExtensions.some((ext) =>
        entryName.toLowerCase().endsWith(ext.toLowerCase())
      );
      if (!hasAllowedExtension) {
        continue;
      }
    }

    const baseValue = parentPath ? posix.join(parentPath, entryName) : entryName;
    complete(isDir ? `${baseValue}/` : baseValue, isDir ? "directory" : "file");
  }
}

function getOptionArgValue(optionName) {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === optionName) {
      return argv[i + 1] || "";
    }
    if (arg.startsWith(`${optionName}=`)) {
      return arg.slice(optionName.length + 1);
    }
  }
  return "";
}

function collectOptionValues(value, previous) {
  if (Array.isArray(previous)) {
    return [...previous, value];
  }

  if (typeof previous === "string" && previous.length > 0) {
    return [previous, value];
  }

  return [value];
}

function collectOrderedContextOperations(argv) {
  const operations = [];
  const tracked = new Set(["--context", "--set", "--json"]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) {
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > -1) {
      const key = token.slice(0, equalsIndex);
      if (!tracked.has(key)) {
        continue;
      }

      const value = token.slice(equalsIndex + 1);
      operations.push({
        type: key.slice(2),
        value
      });
      continue;
    }

    if (!tracked.has(token)) {
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined) {
      continue;
    }

    operations.push({
      type: token.slice(2),
      value
    });
    i += 1;
  }

  return operations;
}

function listProfileCompletions(complete, folderName, options = {}) {
  const workspaceToken = getOptionArgValue("--workspace") || process.env.DUBLO_WORKSPACE || "./.dublo";
  const workspacePath = isAbsolute(workspaceToken)
    ? resolve(workspaceToken)
    : resolve(process.cwd(), workspaceToken);
  const folderPath = join(workspacePath, folderName);

  let entries;
  try {
    entries = readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return;
  }

  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const name = entry.name;
    if (options.fileExtensions?.length) {
      const matchedExt = options.fileExtensions.find((ext) =>
        name.toLowerCase().endsWith(ext.toLowerCase())
      );
      if (!matchedExt) {
        continue;
      }

      const withoutExt = name.slice(0, -matchedExt.length);
      if (!seen.has(withoutExt)) {
        seen.add(withoutExt);
        complete(withoutExt, `${folderName} profile`);
      }
      continue;
    }

    if (!seen.has(name)) {
      seen.add(name);
      complete(name, `${folderName} profile`);
    }
  }
}

function addOptionValueCompletions(completion) {
  const runCommand = completion.commands.get("run");
  if (!runCommand) {
    return;
  }

  const workspaceOption = runCommand.options.get("workspace");
  if (workspaceOption) {
    workspaceOption.handler = (complete) => {
      listPathCompletions(complete);
    };
  }

  const llmOption = runCommand.options.get("llm");
  if (llmOption) {
    llmOption.handler = (complete) => {
      listPathCompletions(complete, { fileExtensions: [".json"] });
      listProfileCompletions(complete, "llm", { fileExtensions: [".json"] });
    };
  }

  const personaOption = runCommand.options.get("persona");
  if (personaOption) {
    personaOption.handler = (complete) => {
      listPathCompletions(complete, { fileExtensions: [".md", ".txt"] });
      listProfileCompletions(complete, "personas", { fileExtensions: [".md", ".txt"] });
    };
  }

  const scenarioOption = runCommand.options.get("scenario");
  if (scenarioOption) {
    scenarioOption.handler = (complete) => {
      listPathCompletions(complete, { fileExtensions: [".md", ".txt"] });
      listProfileCompletions(complete, "scenarios", { fileExtensions: [".md", ".txt"] });
    };
  }

  const contextOption = runCommand.options.get("context");
  if (contextOption) {
    contextOption.handler = (complete) => {
      listPathCompletions(complete, { fileExtensions: [".json", ".yaml", ".yml"] });
      listProfileCompletions(complete, "context", { fileExtensions: [".json", ".yaml", ".yml"] });
    };
  }
}

program
  .name("dublo")
  .description("Agentic LLM loop web testing with Playwright + AWS Bedrock")
  .version("0.1.0", "--version");

program
  .command("run [scenario]")
  .description("Run using workspace config and selectors")
  .option("--workspace <path>", "Workspace directory (contains defaults.json and llm/personas/scenarios/context)")
  .option("--llm <value>", "LLM config file path or profile name in <workspace>/llm")
  .option("--persona <value>", "Persona file path or profile name in <workspace>/personas")
  .option("--scenario <value>", "Scenario file path or profile name in <workspace>/scenarios (or use positional [scenario])")
  .option("--headless", "Run browser in headless mode")
  .option("--debug", "Enable debug logging for this run")
  .option(
    "--context <value>",
    "Context file path or profile name in <workspace>/context (repeatable)",
    collectOptionValues
  )
  .option("--set <keyValue>", "Inline context assignment key.path=value (or key.path:value); repeatable", collectOptionValues)
  .option("--json <object>", "Inline JSON object merged into context (repeatable)", collectOptionValues)
  .action(async (scenarioArg, options) => {
    const orderedContextOperations = collectOrderedContextOperations(process.argv);
    await runCommand({
      ...options,
      scenario: options.scenario || scenarioArg,
      contextOperations: orderedContextOperations
    });
  });

program
  .command("config")
  .alias("init")
  .description("Interactively create or update workspace defaults.json")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--prompt", "Edit the workspace prompt markdown file")
  .option("--show-prompt", "Write the workspace prompt markdown file to stdout")
  .option("-y, --yes", "Accept defaults and write config without prompts")
  .action(async (options) => {
    await configureCommand(options);
  });

const llmProgram = program
  .command("llm")
  .description("Manage LLM profiles");

llmProgram
  .command("config [profile]")
  .description("Interactively create or update an LLM profile")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--region <region>", "Bedrock region override")
  .option("--model-id <id>", "Bedrock model ID override")
  .option("--inference-profile <scope>", "Inference profile scope for models that support it (global or us)")
  .option("--service-tier <tier>", "Service tier for models that support it (default, priority, flex, reserved)")
  .option("--set-default", "Set workspace config llm field to this profile (non-interactive mode)")
  .option("-y, --yes", "Accept defaults/flags and write profile without prompts")
  .action(async (profile, options) => {
    await configureLlmCommand({
      ...options,
      profile
    });
  });

llmProgram
  .command("list")
  .description("List available LLM profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (options) => {
    await listLlmCommand(options);
  });

llmProgram
  .command("show [profile]")
  .description("Show the resolved LLM profile JSON")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--name <profile>", "LLM profile name override")
  .action(async (profile, options) => {
    await showLlmCommand(profile, options);
  });

llmProgram
  .command("validate [profile]")
  .description("Validate one or all LLM profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--name <profile>", "LLM profile name override")
  .action(async (profile, options) => {
    await validateLlmCommand(profile, options);
  });

const personaProgram = program
  .command("persona")
  .description("Manage persona profiles");

personaProgram
  .command("list")
  .description("List available persona profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (options) => {
    await listPersonaCommand(options);
  });

personaProgram
  .command("show <profile>")
  .description("Write persona text to stdout")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (profile, options) => {
    await showPersonaCommand({
      ...options,
      profile
    });
  });

personaProgram
  .command("edit <profile>")
  .description("Write persona text from stdin or open an interactive editor")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (profile, options) => {
    await editPersonaCommand({
      ...options,
      profile
    });
  });

const scenarioProgram = program
  .command("scenario")
  .description("Manage scenario profiles");

scenarioProgram
  .command("list")
  .description("List available scenario profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (options) => {
    await listScenarioCommand(options);
  });

scenarioProgram
  .command("show <profile>")
  .description("Write scenario text to stdout")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (profile, options) => {
    await showScenarioCommand({
      ...options,
      profile
    });
  });

scenarioProgram
  .command("edit <profile>")
  .description("Write scenario text from stdin or open an interactive editor")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (profile, options) => {
    await editScenarioCommand({
      ...options,
      profile
    });
  });

const contextProgram = program
  .command("context")
  .description("Manage context profiles");

contextProgram
  .command("list")
  .description("List available context profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (options) => {
    await listContextCommand(options);
  });

contextProgram
  .command("show <profile>")
  .description("Write resolved context object as JSON to stdout")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .action(async (profile, options) => {
    await showContextCommand({
      ...options,
      profile
    });
  });

contextProgram
  .command("edit <profile>")
  .description("Write context from stdin or open an interactive editor")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--yaml", "Force YAML file output (.yaml/.yml) for new or matching existing profile")
  .option("--json", "Force JSON file output (.json) for new or matching existing profile")
  .action(async (profile, options) => {
    await editContextCommand({
      ...options,
      profile
    });
  });

contextProgram
  .command("validate [profile]")
  .description("Validate one or all context profiles")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--name <profile>", "Context profile name override")
  .action(async (profile, options) => {
    await validateContextCommand(profile, options);
  });

const completion = tab(program, { completionCommandName: "completion" });
addOptionValueCompletions(completion);

program.parseAsync(process.argv).catch((error) => {
  if (isInterruptError(error)) {
    process.stderr.write("Interrupted.\n");
    process.exitCode = 130;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

function isInterruptError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = typeof error.code === "string" ? error.code : "";
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";

  return code === "ABORT_ERR" || name === "AbortError" || /aborted with ctrl\+c/i.test(message);
}
