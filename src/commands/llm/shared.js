import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export function resolveWorkspacePath(workspace) {
  const workspaceInput = firstDefined(workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  return path.resolve(process.cwd(), workspaceInput);
}

export function listLlmProfileNames(workspacePath) {
  const llmDir = path.join(workspacePath, "llm");
  let entries = [];
  try {
    entries = readdirSync(llmDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort((a, b) => a.localeCompare(b));
}

export function inferSingleLlmProfile(workspacePath) {
  const names = listLlmProfileNames(workspacePath);
  return names.length === 1 ? names[0] : "";
}

export function resolveLlmProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(process.cwd(), value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  const base = path.join(workspacePath, "llm");
  const candidates = [path.join(base, value), path.join(base, `${value}.json`)];
  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export async function readJsonObject(filePath, label) {
  const raw = await readFile(filePath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label} '${filePath}': ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} '${filePath}' must be a JSON object.`);
  }

  return parsed;
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
