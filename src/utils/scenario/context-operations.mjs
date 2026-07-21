import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as yaml from "js-yaml";

const FORBIDDEN_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_INLINE_JSON_LENGTH = 16 * 1024;
const SECRET_ENV_PREFIX = "DUBLO_SECRET_";

async function parseContextFile(contextFile) {
  const resolved = path.resolve(process.cwd(), contextFile);
  const content = await readFile(resolved, "utf8");

  const extension = path.extname(resolved).toLowerCase();
  let parsed;

  try {
    parsed = extension === ".yaml" || extension === ".yml" ? yaml.load(content) : JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid context file '${resolved}': ${detail}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Context file '${resolved}' must contain an object.`);
  }

  return parsed;
}

export async function loadContextFromOperations(operations, environment = process.env) {
  const merged = {};
  const secretValues = loadEnvironmentSecrets(environment);
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || typeof operation !== "object") continue;

    if (operation.type === "context") {
      Object.assign(merged, await parseContextFile(operation.value));
    } else if (operation.type === "set") {
      const parsed = parseSetEntry(operation.value);
      applyContextPathValue(merged, parsed.pathParts, parsed.value, "--set");
    } else if (operation.type === "json") {
      Object.assign(merged, parseJsonEntry(operation.value));
    } else if (operation.type === "secret") {
      const parsed = parseSecretEntry(operation.value, environment);
      secretValues.set(parsed.path, parsed.value);
    }
  }

  return { contextData: merged, secretValues };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSafeContextKey(key, sourceLabel) {
  if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
    throw new Error(`Unsafe context key '${key}' in ${sourceLabel}.`);
  }
}

function validateObjectKeys(value, sourceLabel) {
  if (!isPlainObject(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    assertSafeContextKey(key, sourceLabel);
    validateObjectKeys(nested, sourceLabel);
  }
}

function parseScalarInlineValue(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (trimmed === "") return "";

  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null") return null;
  if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function applyContextPathValue(target, pathParts, value, sourceLabel) {
  let current = target;
  for (let index = 0; index < pathParts.length; index += 1) {
    const key = pathParts[index];
    assertSafeContextKey(key, sourceLabel);
    if (index === pathParts.length - 1) {
      current[key] = value;
      return;
    }

    const next = current[key];
    if (next === undefined || next === null) {
      current[key] = {};
      current = current[key];
    } else if (isPlainObject(next)) {
      current = next;
    } else {
      throw new Error(`Cannot set nested context path '${pathParts.join(".")}' because '${key}' is not an object.`);
    }
  }
}

function parseSetEntry(entry) {
  const raw = String(entry || "").trim();
  const equalsIndex = raw.indexOf("=");
  const colonIndex = raw.indexOf(":");
  const delimiterIndex = equalsIndex >= 0 ? equalsIndex : colonIndex;
  if (delimiterIndex < 1) {
    throw new Error(`Invalid --set entry '${raw}'. Expected key.path=value or key.path:value.`);
  }

  const pathParts = raw
    .slice(0, delimiterIndex)
    .trim()
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (pathParts.length === 0) {
    throw new Error(`Invalid --set entry '${raw}'. Missing key path.`);
  }

  return { pathParts, value: parseScalarInlineValue(raw.slice(delimiterIndex + 1)) };
}

function parseSecretEntry(entry, environment) {
  const raw = String(entry || "").trim();
  const equalsIndex = raw.indexOf("=");
  const path = parseSecretPath(equalsIndex < 0 ? raw : raw.slice(0, equalsIndex), "--secret");
  const environmentVariable = equalsIndex < 0 ? secretEnvironmentVariable(path) : raw.slice(equalsIndex + 1).trim();
  return { path, value: readSecretEnvironmentVariable(environmentVariable, environment) };
}

function loadEnvironmentSecrets(environment) {
  const secrets = new Map();
  for (const [environmentVariable, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!environmentVariable.startsWith(SECRET_ENV_PREFIX)) continue;

    const path = parseSecretPath(
      environmentVariable.slice(SECRET_ENV_PREFIX.length).replaceAll("__", "."),
      environmentVariable
    );
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Secret environment variable '${environmentVariable}' is not set or is empty.`);
    }
    secrets.set(path, value);
  }
  return secrets;
}

function parseSecretPath(value, sourceLabel) {
  const path = String(value || "").trim();
  const pathParts = path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (pathParts.length === 0 || pathParts.join(".") !== path) {
    throw new Error(`Invalid secret path '${path}' in ${sourceLabel}. Expected a dotted path.`);
  }
  for (const key of pathParts) assertSafeContextKey(key, sourceLabel);
  return path;
}

function secretEnvironmentVariable(path) {
  return `${SECRET_ENV_PREFIX}${path.replaceAll(".", "__")}`;
}

function readSecretEnvironmentVariable(environmentVariable, environment) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentVariable)) {
    throw new Error(`Invalid secret environment variable '${environmentVariable}'. Names use letters, numbers, and underscores.`);
  }

  const value = environment[environmentVariable];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Secret environment variable '${environmentVariable}' is not set or is empty.`);
  }
  return value;
}

function parseJsonEntry(rawJson) {
  const jsonText = String(rawJson || "").trim();
  if (!jsonText) throw new Error("Invalid --json entry: value cannot be empty.");
  if (jsonText.length > MAX_INLINE_JSON_LENGTH) {
    throw new Error(`Invalid --json entry: payload too large (${jsonText.length} chars, max ${MAX_INLINE_JSON_LENGTH}).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --json entry '${jsonText}': ${detail}`);
  }

  if (!isPlainObject(parsed)) throw new Error("Invalid --json entry: top-level value must be a JSON object.");
  validateObjectKeys(parsed, "--json");
  return parsed;
}

function getValueByPath(source, rawPath) {
  if (!rawPath) return undefined;

  let current = source;
  for (const part of rawPath.split(".").map((item) => item.trim()).filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function resolveFillValue(rawValue, contextData, humanInputs, secretValues = new Map()) {
  if (typeof rawValue !== "string") throw new Error("Planner fill action value must be a string.");

  const inputMatch = rawValue.match(/^\{\{input:([^}]+)\}\}$/);
  if (inputMatch) {
    const key = inputMatch[1].trim();
    const value = humanInputs.get(key);
    if (!value) throw new Error(`Missing human input value for key '${key}'.`);
    return value;
  }

  const contextMatch = rawValue.match(/^\{\{context:([^}]+)\}\}$/);
  if (contextMatch) {
    const contextPath = contextMatch[1].trim();
    let value = getValueByPath(contextData, contextPath);
    if ((value === undefined || value === null) && contextPath.startsWith("contextData.")) {
      value = getValueByPath(contextData, contextPath.slice("contextData.".length));
    }
    if ((value === undefined || value === null) && contextPath.startsWith("payload.contextData.")) {
      value = getValueByPath(contextData, contextPath.slice("payload.contextData.".length));
    }
    if (value === undefined || value === null) {
      throw new Error(
        `Missing context value for path '${contextPath}'. Use placeholders rooted at the merged context object, for example {{context:signup.email}}.`
      );
    }
    return String(value);
  }

  const secretMatch = rawValue.match(/^\{\{secret:([^}]+)\}\}$/);
  if (secretMatch) {
    const secretPath = secretMatch[1].trim();
    const value = secretValues.get(secretPath);
    if (value === undefined) {
      throw new Error(`Missing secret value for path '${secretPath}'. Use an available secret path from the planner context.`);
    }
    return value;
  }

  return rawValue;
}

export function redactSecretValues(value, secretValues) {
  return redactSecretValue(value, new Set(secretValues.values()));
}

function redactSecretValue(value, secretValues) {
  if (typeof value === "string") return secretValues.has(value) ? "*******" : value;
  if (Array.isArray(value)) return value.map((entry) => redactSecretValue(entry, secretValues));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSecretValue(nested, secretValues)]));
}