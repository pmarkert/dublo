import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BUILTIN_PERSONA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../resources/templates/personas");

export function resolveWorkspacePath(workspace) {
  const workspaceInput = firstDefined(workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  return path.resolve(process.cwd(), workspaceInput);
}

export function listPersonaProfileNames(workspacePath) {
  const personaDir = path.join(workspacePath, "personas");
  let entries = [];
  try {
    entries = readdirSync(personaDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && hasPersonaExtension(entry.name))
    .map((entry) => stripPersonaExtension(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function listBuiltinPersonaTemplateNames() {
  let entries = [];
  try {
    entries = readdirSync(BUILTIN_PERSONA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && hasPersonaExtension(entry.name))
    .map((entry) => stripPersonaExtension(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function inferSinglePersonaProfile(workspacePath) {
  const names = listPersonaProfileNames(workspacePath);
  return names.length === 1 ? names[0] : "";
}

export function resolvePersonaProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(process.cwd(), value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  const workspaceResolved = resolveWorkspacePersonaProfilePath(workspacePath, value);
  if (workspaceResolved) {
    return workspaceResolved;
  }

  const builtInPath = resolveBuiltinPersonaTemplatePath(value);
  if (builtInPath) {
    return builtInPath;
  }

  return "";
}

export function resolveWorkspacePersonaProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const base = path.join(workspacePath, "personas");
  const candidates = [path.join(base, value), path.join(base, `${value}.md`), path.join(base, `${value}.txt`)];
  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export function resolveBuiltinPersonaTemplatePath(value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(BUILTIN_PERSONA_DIR, value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  const normalized = stripPersonaExtension(String(value || "").trim());
  const candidates = [path.join(BUILTIN_PERSONA_DIR, `${normalized}.md`), path.join(BUILTIN_PERSONA_DIR, `${normalized}.txt`)];
  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export function defaultPersonaProfilePath(workspacePath, name) {
  return path.join(workspacePath, "personas", `${sanitizePersonaProfileName(name)}.md`);
}

export async function readPersonaText(filePath) {
  return readFile(filePath, "utf8");
}

export function sanitizePersonaProfileName(value) {
  const normalized = stripPersonaExtension(String(value || "").trim()).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!normalized) {
    throw new Error("Persona profile name cannot be empty.");
  }
  return normalized;
}

function stripPersonaExtension(value) {
  return String(value || "").replace(/\.(md|txt)$/i, "");
}

function hasPersonaExtension(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".txt");
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
