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
  .version("0.1.0");

program
  .command("run")
  .description("Run using workspace config and selectors")
  .option("--workspace <path>", "Workspace directory (contains config.json and llm/personas/scenarios/context)")
  .option("--llm <value>", "LLM config file path or profile name in <workspace>/llm")
  .option("--persona <value>", "Persona file path or profile name in <workspace>/personas")
  .option("--scenario <value>", "Scenario file path or profile name in <workspace>/scenarios")
  .option("--headless", "Run browser in headless mode (default is headed)")
  .option(
    "--context <value>",
    "Context file path or profile name in <workspace>/context (repeatable, merged first-to-last)",
    collectOptionValues
  )
  .option("--set <keyValue>", "Inline context assignment key.path=value (or key.path:value); repeatable", collectOptionValues)
  .option("--json <object>", "Inline JSON object merged into context (repeatable)", collectOptionValues)
  .action(async (options) => {
    const orderedContextOperations = collectOrderedContextOperations(process.argv);
    await runCommand({
      ...options,
      contextOperations: orderedContextOperations
    });
  });

program
  .command("configure")
  .alias("config")
  .description("Interactively create or update workspace config.json")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("-y, --yes", "Accept defaults and write config without prompts")
  .action(async (options) => {
    await configureCommand(options);
  });

const llmProgram = program
  .command("llm")
  .description("Manage LLM profiles");

llmProgram
  .command("configure [profile]")
  .alias("config")
  .description("Interactively create or update an LLM profile")
  .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
  .option("--region <region>", "Bedrock region override")
  .option("--model-id <id>", "Bedrock model ID override")
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

const completion = tab(program, { completionCommandName: "completion" });
addOptionValueCompletions(completion);

program.parseAsync(process.argv);
