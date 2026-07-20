import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as yaml from "js-yaml";

const FORBIDDEN_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function resolveWorkspacePath(workspace) {
  const workspaceInput = firstDefined(workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  return path.resolve(process.cwd(), workspaceInput);
}

export function listContextProfileNames(workspacePath) {
  const contextDir = path.join(workspacePath, "context");
  let entries = [];
  try {
    entries = readdirSync(contextDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && hasContextExtension(entry.name))
    .map((entry) => stripContextExtension(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function inferSingleContextProfile(workspacePath) {
  const names = listContextProfileNames(workspacePath);
  return names.length === 1 ? names[0] : "";
}

export function resolveContextProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const direct = path.resolve(process.cwd(), value);
  const directResolved = tryResolveFile(direct);
  if (directResolved) {
    return directResolved;
  }

  return resolveWorkspaceContextProfilePath(workspacePath, value);
}

export function resolveWorkspaceContextProfilePath(workspacePath, value) {
  if (!value) {
    return "";
  }

  const base = path.join(workspacePath, "context");
  const candidates = [
    path.join(base, value),
    path.join(base, `${value}.json`),
    path.join(base, `${value}.yaml`),
    path.join(base, `${value}.yml`)
  ];

  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export function defaultContextProfilePath(workspacePath, name, ext = ".yaml") {
  const normalizedExt = normalizeContextExtension(ext);
  const normalizedName = sanitizeContextProfileName(name);
  return path.join(workspacePath, "context", `${normalizedName}${normalizedExt}`);
}

export function preferredContextExtension(value) {
  const raw = String(value || "").toLowerCase().trim();
  if (raw.endsWith(".yaml")) return ".yaml";
  if (raw.endsWith(".yml")) return ".yml";
  return ".yaml";
}

export async function readContextObject(filePath) {
  const raw = await readFile(filePath, "utf8");
  const extension = path.extname(filePath).toLowerCase();
  const isYaml = extension === ".yaml" || extension === ".yml";

  let parsed;
  try {
    if (isYaml) {
      parsed = yaml.load(raw);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isYaml && detail === "expected a document, but the input is empty" && isCommentOnlyYaml(raw)) {
      return {};
    }
    throw new Error(`Invalid context file '${filePath}': ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Context file '${filePath}' must contain an object.`);
  }

  validateObjectKeys(parsed, filePath);
  return parsed;
}

export function sanitizeContextProfileName(value) {
  const normalized = stripContextExtension(String(value || "").trim()).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!normalized) {
    throw new Error("Context profile name cannot be empty.");
  }
  return normalized;
}

function normalizeContextExtension(value) {
  const normalized = String(value || "").toLowerCase().trim();
  if (normalized === ".yaml") return ".yaml";
  if (normalized === ".yml") return ".yml";
  return ".json";
}

function stripContextExtension(value) {
  return String(value || "").replace(/\.(json|yaml|yml)$/i, "");
}

function hasContextExtension(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.endsWith(".json") || normalized.endsWith(".yaml") || normalized.endsWith(".yml");
}

function isCommentOnlyYaml(value) {
  return value.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("#");
  });
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

function validateObjectKeys(value, sourceLabel) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
      throw new Error(`Unsafe context key '${key}' in ${sourceLabel}.`);
    }

    validateObjectKeys(nested, sourceLabel);
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
