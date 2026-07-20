import { readdirSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";

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

export function addRunOptionValueCompletions(completion) {
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