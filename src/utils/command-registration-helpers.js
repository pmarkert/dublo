import { readdirSync } from "node:fs";
import { isAbsolute, join, posix, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listAvailableRuns } from "./run-reports.js";

const TEMPLATE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../resources/templates"
);

const CONFIG_SETTINGS = [
  "base-url",
  "llm",
  "persona",
  "max-steps",
  "headless",
  "screenshots",
  "debug",
  "output-dir",
  "observation-config"
];

function currentCompletionToken() {
  const argv = process.argv;
  const doubleDashIndex = argv.indexOf("--");
  if (doubleDashIndex === -1 || doubleDashIndex === argv.length - 1) {
    return "";
  }

  return argv[argv.length - 1] ?? "";
}

export function listPathCompletions(complete, options = {}) {
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

export function getOptionArgValue(optionName) {
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

export function collectOptionValues(value, previous) {
  if (Array.isArray(previous)) {
    return [...previous, value];
  }

  if (typeof previous === "string" && previous.length > 0) {
    return [previous, value];
  }

  return [value];
}

export function collectOrderedContextOperations(argv) {
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
        value,
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
      value,
    });
    i += 1;
  }

  return operations;
}

export function listProfileCompletions(complete, folderName, options = {}) {
  const workspacePath = resolveCompletionWorkspace();
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

export function listTemplateCompletions(complete, templateType, options = {}) {
  listEntries(complete, join(TEMPLATE_DIRECTORY, templateType), "built-in template", options);
}

export function listRunCompletions(complete) {
  for (const run of listAvailableRuns({ workspace: getOptionArgValue("--workspace") || undefined })) {
    complete(run.runId, `${run.status} run`);
  }
}

export function addRunOptionValueCompletions(completion) {
  addWorkspaceCompletionHandlers(completion);
  addRunCompletionHandlers(completion);
  addProfileCompletionHandlers(completion);
  addReportCompletionHandlers(completion);
  addEnumCompletionHandlers(completion);
}

function resolveCompletionWorkspace() {
  const workspaceToken = getOptionArgValue("--workspace") || process.env.DUBLO_WORKSPACE || "./.dublo";
  return isAbsolute(workspaceToken) ? resolve(workspaceToken) : resolve(process.cwd(), workspaceToken);
}

function listEntries(complete, directory, label, options) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = options.fileExtensions?.find((item) =>
      entry.name.toLowerCase().endsWith(item.toLowerCase())
    );
    if (options.fileExtensions?.length && !extension) continue;
    const value = extension ? entry.name.slice(0, -extension.length) : entry.name;
    if (seen.has(value)) continue;
    seen.add(value);
    complete(value, label);
  }
}

function addWorkspaceCompletionHandlers(completion) {
  for (const command of completion.commands.values()) {
    setOptionHandler(command, "workspace", (complete) => listPathCompletions(complete));
  }
}

function addRunCompletionHandlers(completion) {
  const llm = (complete) => {
    listPathCompletions(complete, { fileExtensions: [".json"] });
    listProfileCompletions(complete, "llm", { fileExtensions: [".json"] });
  };
  const persona = (complete) => {
    listPathCompletions(complete, { fileExtensions: [".md", ".txt"] });
    listProfileCompletions(complete, "personas", { fileExtensions: [".md", ".txt"] });
    listTemplateCompletions(complete, "personas", { fileExtensions: [".md", ".txt"] });
  };
  const scenario = (complete) => {
    listPathCompletions(complete, { fileExtensions: [".md", ".txt"] });
    listProfileCompletions(complete, "scenarios", { fileExtensions: [".md", ".txt"] });
    listTemplateCompletions(complete, "scenarios", { fileExtensions: [".md", ".txt"] });
  };
  const context = (complete) => {
    listPathCompletions(complete, { fileExtensions: [".json", ".yaml", ".yml"] });
    listProfileCompletions(complete, "context", { fileExtensions: [".json", ".yaml", ".yml"] });
  };

  setOptionHandler(getCommand(completion, "run"), "llm", llm);
  setOptionHandler(getCommand(completion, "run"), "persona", persona);
  setOptionHandler(getCommand(completion, "run"), "scenario", scenario);
  setOptionHandler(getCommand(completion, "run"), "context", context);
  setArgumentHandler(getCommand(completion, "run"), scenario);
  setOptionHandler(getCommand(completion, "init"), "llm", llm);
}

function addProfileCompletionHandlers(completion) {
  const llm = (complete) => listProfileCompletions(complete, "llm", { fileExtensions: [".json"] });
  const persona = (complete) => {
    listProfileCompletions(complete, "personas", { fileExtensions: [".md", ".txt"] });
    listTemplateCompletions(complete, "personas", { fileExtensions: [".md", ".txt"] });
  };
  const scenario = (complete) => {
    listProfileCompletions(complete, "scenarios", { fileExtensions: [".md", ".txt"] });
    listTemplateCompletions(complete, "scenarios", { fileExtensions: [".md", ".txt"] });
  };
  const context = (complete) => listProfileCompletions(complete, "context", { fileExtensions: [".json", ".yaml", ".yml"] });

  for (const commandName of ["llm config", "llm show", "llm validate"]) {
    const command = getCommand(completion, commandName);
    setArgumentHandler(command, llm);
    setOptionHandler(command, "name", llm);
  }
  for (const commandName of ["persona show", "persona edit"]) {
    setArgumentHandler(getCommand(completion, commandName), persona);
  }
  for (const commandName of ["scenario show", "scenario edit"]) {
    setArgumentHandler(getCommand(completion, commandName), scenario);
  }
  for (const commandName of ["context show", "context edit", "context validate"]) {
    const command = getCommand(completion, commandName);
    setArgumentHandler(command, context);
    setOptionHandler(command, "name", context);
  }
  for (const commandName of ["config context add", "config context remove"]) {
    setArgumentHandler(getCommand(completion, commandName), context);
  }
}

function addReportCompletionHandlers(completion) {
  for (const commandName of ["report show", "report render", "report open"]) {
    setArgumentHandler(getCommand(completion, commandName), listRunCompletions);
  }
}

function addEnumCompletionHandlers(completion) {
  const choiceHandler = (choices) => (complete) => {
    for (const choice of choices) complete(choice, "option");
  };
  for (const commandName of ["config set", "config unset"]) {
    setArgumentHandler(getCommand(completion, commandName), choiceHandler(CONFIG_SETTINGS));
  }
  for (const commandName of ["config show", "config validate", "report list", "report show"]) {
    setOptionHandler(getCommand(completion, commandName), "format", choiceHandler(["text", "json"]));
  }
  setOptionHandler(getCommand(completion, "report list"), "status", choiceHandler(["passed", "failed", "interrupted"]));
  setOptionHandler(getCommand(completion, "report render"), "report", choiceHandler(["markdown", "html"]));
  for (const commandName of ["config report add", "config report remove"]) {
    setArgumentHandler(getCommand(completion, commandName), choiceHandler(["markdown", "html"]));
  }
  setOptionHandler(getCommand(completion, "llm config"), "inference-profile", choiceHandler(["global", "us"]));
  setOptionHandler(getCommand(completion, "llm config"), "service-tier", choiceHandler(["default", "priority", "flex", "reserved"]));
}

function getCommand(completion, name) {
  return completion.commands.get(name);
}

function setOptionHandler(command, optionName, handler) {
  const option = command?.options.get(optionName);
  if (option) option.handler = handler;
}

function setArgumentHandler(command, handler) {
  const argument = command?.arguments.values().next().value;
  if (argument) argument.handler = handler;
}