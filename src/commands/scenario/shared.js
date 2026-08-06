import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BUILTIN_SCENARIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../resources/templates/scenarios");
const TEST_CONFIG_SUFFIX = ".config.json";

export function resolveWorkspacePath(workspace) {
  const workspaceInput = firstDefined(workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  return path.resolve(process.cwd(), workspaceInput);
}

export function listScenarioProfileNames(workspacePath) {
  const scenarioDir = path.join(workspacePath, "scenarios");
  const names = new Set();

  try {
    for (const entry of readdirSync(scenarioDir, { withFileTypes: true })) {
      if (entry.isFile() && hasScenarioExtension(entry.name) && !entry.name.endsWith(TEST_CONFIG_SUFFIX)) {
        names.add(stripScenarioExtension(entry.name));
      }
    }
  } catch {}

  return [...names].sort((a, b) => a.localeCompare(b));
}

export function defaultScenarioProfilePath(workspacePath, name) {
  return path.join(workspacePath, "scenarios", `${sanitizeScenarioProfileName(name)}.md`);
}

export function defaultTestConfigPath(workspacePath, name) {
  return path.join(workspacePath, "scenarios", `${sanitizeScenarioProfileName(name)}${TEST_CONFIG_SUFFIX}`);
}

export function resolveTestConfigPath(workspacePath, value) {
  if (!value) return "";
  const normalized = String(value || "").trim();
  if (!normalized || normalized.includes(path.sep) || normalized.includes("/")) return "";
  return resolveWorkspaceScenarioProfilePath(workspacePath, normalized)
    ? defaultTestConfigPath(workspacePath, normalized)
    : "";
}

export function listBuiltinScenarioTemplateNames() {
  let entries = [];
  try {
    entries = readdirSync(BUILTIN_SCENARIO_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && hasScenarioExtension(entry.name))
    .map((entry) => stripScenarioExtension(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function inferSingleScenarioProfile(workspacePath) {
  const names = listScenarioProfileNames(workspacePath);
  return names.length === 1 ? names[0] : "";
}

export function resolveScenarioProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(process.cwd(), value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  const workspaceResolved = resolveWorkspaceScenarioProfilePath(workspacePath, value);
  if (workspaceResolved) {
    return workspaceResolved;
  }

  const builtInPath = resolveBuiltinScenarioTemplatePath(value);
  if (builtInPath) {
    return builtInPath;
  }

  return "";
}

export function resolveWorkspaceScenarioProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const base = path.join(workspacePath, "scenarios");
  const candidates = [path.join(base, value), path.join(base, `${value}.md`), path.join(base, `${value}.txt`)];
  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export function resolveBuiltinScenarioTemplatePath(value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(BUILTIN_SCENARIO_DIR, value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  const normalized = stripScenarioExtension(String(value || "").trim());
  const candidates = [path.join(BUILTIN_SCENARIO_DIR, `${normalized}.md`), path.join(BUILTIN_SCENARIO_DIR, `${normalized}.txt`)];
  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export async function readScenarioText(filePath) {
  return readFile(filePath, "utf8");
}

export function sanitizeScenarioProfileName(value) {
  const normalized = stripScenarioExtension(String(value || "").trim()).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!normalized) {
    throw new Error("Scenario profile name cannot be empty.");
  }
  return normalized;
}

function stripScenarioExtension(value) {
  return String(value || "").replace(/\.(md|txt)$/i, "");
}

function hasScenarioExtension(value) {
  const normalized = String(value || "").toLowerCase();
  return (normalized.endsWith(".md") || normalized.endsWith(".txt")) && !normalized.endsWith(TEST_CONFIG_SUFFIX);
}

function tryResolveFile(filePath) {
  try {
    const stat = readdirSync(path.dirname(filePath), { withFileTypes: true });
    const target = path.basename(filePath);
    const match = stat.find((entry) => entry.name === target && entry.isFile());
    return match ? filePath : "";
  } catch {
    return "";
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
