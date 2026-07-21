import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as yaml from "js-yaml";
import { generateReportArtifacts, rerenderReportArtifacts } from "../reporting/report-artifacts.mjs";
import { createBedrockPlanner } from "../node/bedrock-planner.js";
import { createOpenAICompatiblePlanner } from "../node/openai-compatible-planner.js";
import { createPlaywrightBrowserFactory } from "../node/playwright-browser.js";
import { createTerminalInteractionProvider } from "../node/terminal-interaction.js";

const FORBIDDEN_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_INLINE_JSON_LENGTH = 16 * 1024;
const SECRET_ENV_PREFIX = "DUBLO_SECRET_";

const DEFAULT_OBSERVATION_CONFIG = {
  controlsSelector:
    "button, a, input, textarea, select, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']",
  maxControls: 80,
  ignoreControlSelectors: ["button[aria-label='Open Tanstack query devtools']"],
  ignoreControlTextPatterns: [],
  priorityControlSelectors: ["nav a", "nav button", "[role='navigation'] a", "[role='navigation'] button"],
  headingSelector: "h1, h2, h3",
  maxHeadings: 10,
  alertSelector: "[role='alert']",
  maxAlerts: 6,
  documentTextScopeSelectors: ["main", "[role='main']"],
  documentTextExcludeSelectors: ["button[aria-label='Open Tanstack query devtools']"],
  documentTextMaxChars: 2400,
};

function mergeObservationConfig(defaultConfig, overrideConfig) {
  if (!overrideConfig || typeof overrideConfig !== "object" || Array.isArray(overrideConfig)) {
    return { ...defaultConfig };
  }

  const merged = { ...defaultConfig };
  for (const [key, value] of Object.entries(overrideConfig)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      merged[key] = [...value];
      continue;
    }

    if (value && typeof value === "object") {
      const current = merged[key];
      merged[key] = mergeObservationConfig(
        current && typeof current === "object" && !Array.isArray(current) ? current : {},
        value
      );
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function normalizeScreenshotMode(rawValue) {
  const normalized = String(rawValue || "")
    .toLowerCase()
    .trim();
  if (normalized === "fullpage" || normalized === "full-page") return "fullpage";
  if (normalized === "viewport") return "viewport";
  return "none";
}

async function loadObservationConfig(observationConfigFile) {
  if (!observationConfigFile) {
    return { ...DEFAULT_OBSERVATION_CONFIG };
  }

  const resolved = path.resolve(process.cwd(), observationConfigFile);
  const content = await readFile(resolved, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in observation config file '${resolved}': ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Observation config file '${resolved}' must contain a JSON object.`);
  }

  return mergeObservationConfig(DEFAULT_OBSERVATION_CONFIG, parsed);
}

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveRunLabel(config) {
  if (config.scenarioFile) {
    const fileName = path.basename(String(config.scenarioFile));
    const profileName = path.basename(fileName, path.extname(fileName));
    return sanitizeSegment(profileName || "scenario");
  }

  return "adhoc";
}

function formatRunDateTime(value) {
  return value.toISOString().replace(/[.:]/g, "-");
}

function resolveRunOutcome(status) {
  if (status === "passed") return "pass";
  if (status === "interrupted") return "abort";
  return "fail";
}

function createRunId(startedAt, outcome, label) {
  return `${formatRunDateTime(startedAt)}_${outcome}_${label}`;
}

function clip(value, limit = 180) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1)}...`;
}

export { rerenderReportArtifacts };

function createRunnerLogger(headed) {
  const emit = (level, message) => {
    if (headed) {
      return;
    }

    const timestamp = new Date().toISOString();
    process.stdout.write(`[agentic ${timestamp}] ${level.toUpperCase()}: ${message}\n`);
  };

  return {
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

function createDebugLogger(enabled) {
  const emit = (message) => {
    if (!enabled) {
      return;
    }

    const timestamp = new Date().toISOString();
    process.stdout.write(`[agentic-debug ${timestamp}] ${message}\n`);
  };

  return {
    log: emit,
  };
}

function stripAnsi(value) {
  return String(value || "").replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "");
}

function errorMessage(error) {
  return stripAnsi(error instanceof Error ? error.message : String(error));
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addTokenUsageTotals(target, delta) {
  if (!target || !delta) {
    return;
  }

  target.inputTokens += toNumberOrZero(delta.inputTokens);
  target.outputTokens += toNumberOrZero(delta.outputTokens);
  target.totalTokens += toNumberOrZero(delta.totalTokens);
  target.cacheReadInputTokens += toNumberOrZero(delta.cacheReadInputTokens);
  target.cacheWriteInputTokens += toNumberOrZero(delta.cacheWriteInputTokens);
  target.plannerCalls += 1;
}

export function classifyRecoverableActionError(error) {
  const message = errorMessage(error).toLowerCase();

  if (
    message.includes("element is not enabled") ||
    message.includes("<button disabled") ||
    message.includes("disabled target before click")
  ) {
    return "disabled_target";
  }

  if (message.includes("planner target not found")) {
    return "target_disappeared";
  }

  if (message.includes("planner select_option target is not a native select")) {
    return "invalid_selection";
  }

  if (message.includes("alternating scroll loop")) {
    return "scroll_loop";
  }

  return null;
}

export function isAlternatingScrollLoop(actionHistory, nextAction) {
  if (nextAction.action !== "scroll") {
    return false;
  }

  const recentScrolls = actionHistory
    .filter(
      ({ outcome, action }) =>
        outcome === "ok" &&
        action.payload.action === "scroll" &&
        action.payload.containerId === nextAction.containerId
    )
    .slice(-4)
    .map(({ action }) => action.payload.direction);

  if (recentScrolls.length < 4) {
    return false;
  }

  const directions = [...recentScrolls, nextAction.direction];
  return directions.every((direction, index) => index === 0 || direction !== directions[index - 1]);
}

async function isTargetDisabled(target) {
  try {
    return await target.evaluate((element) => {
      const disabled = "disabled" in element && Boolean(element.disabled);
      const ariaDisabled = element.getAttribute("aria-disabled") === "true";
      return disabled || ariaDisabled;
    });
  } catch {
    return false;
  }
}

function getConfiguredModelPricing(config) {
  const inputOverride = toNumberOrZero(config.llm.inputPrice);
  const outputOverride = toNumberOrZero(config.llm.outputPrice);
  const hasInputOverride = Number.isFinite(Number(config.llm.inputPrice));
  const hasOutputOverride = Number.isFinite(Number(config.llm.outputPrice));

  if (!hasInputOverride && !hasOutputOverride) {
    return null;
  }

  const base = {
    currency: config.llm.currency || "USD",
    tokenUnit: Number.isFinite(Number(config.llm.tokenUnit)) ? Number(config.llm.tokenUnit) : 1000000,
    inputUsdPerUnit: 0,
    outputUsdPerUnit: 0,
    cacheReadUsdPerUnit: toNumberOrZero(config.llm.cacheReadPrice),
    cacheWriteUsdPerUnit: toNumberOrZero(config.llm.cacheWritePrice),
  };

  return {
    ...base,
    inputUsdPerUnit: hasInputOverride ? inputOverride : toNumberOrZero(base.inputUsdPerUnit),
    outputUsdPerUnit: hasOutputOverride ? outputOverride : toNumberOrZero(base.outputUsdPerUnit),
  };
}

function calculateCostEstimate(tokenUsage, pricing) {
  if (!tokenUsage || !pricing) {
    return null;
  }

  const divisor = Number(pricing.tokenUnit);
  if (!Number.isFinite(divisor) || divisor <= 0) {
    return null;
  }

  const inputCost = (toNumberOrZero(tokenUsage.inputTokens) / divisor) * toNumberOrZero(pricing.inputUsdPerUnit);
  const outputCost = (toNumberOrZero(tokenUsage.outputTokens) / divisor) * toNumberOrZero(pricing.outputUsdPerUnit);
  const cacheReadCost =
    (toNumberOrZero(tokenUsage.cacheReadInputTokens) / divisor) * toNumberOrZero(pricing.cacheReadUsdPerUnit);
  const cacheWriteCost =
    (toNumberOrZero(tokenUsage.cacheWriteInputTokens) / divisor) * toNumberOrZero(pricing.cacheWriteUsdPerUnit);
  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    currency: pricing.currency,
    tokenUnit: pricing.tokenUnit,
    rates: {
      inputUsdPerUnit: pricing.inputUsdPerUnit,
      outputUsdPerUnit: pricing.outputUsdPerUnit,
      cacheReadUsdPerUnit: pricing.cacheReadUsdPerUnit,
      cacheWriteUsdPerUnit: pricing.cacheWriteUsdPerUnit,
    },
    costs: {
      input: Number(inputCost.toFixed(10)),
      output: Number(outputCost.toFixed(10)),
      cacheRead: Number(cacheReadCost.toFixed(10)),
      cacheWrite: Number(cacheWriteCost.toFixed(10)),
      total: Number(totalCost.toFixed(10)),
    },
  };
}

function modelSupportsBedrockPromptCaching(modelId) {
  const normalized = String(modelId || "").toLowerCase();
  return (
    normalized.startsWith("anthropic.claude") ||
    normalized.startsWith("us.anthropic.claude") ||
    normalized.startsWith("amazon.nova")
  );
}

async function parseContextFile(contextFile) {
  const resolved = path.resolve(process.cwd(), contextFile);
  const content = await readFile(resolved, "utf8");

  const extension = path.extname(resolved).toLowerCase();
  let parsed;

  try {
    if (extension === ".yaml" || extension === ".yml") {
      parsed = yaml.load(content);
    } else {
      parsed = JSON.parse(content);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid context file '${resolved}': ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Context file '${resolved}' must contain an object.`);
  }

  return parsed;
}

export async function loadContextFromOperations(operations, environment = process.env) {
  const merged = {};
  const secretValues = loadEnvironmentSecrets(environment);
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || typeof operation !== "object") {
      continue;
    }

    if (operation.type === "context") {
      const parsed = await parseContextFile(operation.value);
      Object.assign(merged, parsed);
      continue;
    }

    if (operation.type === "set") {
      const parsed = parseSetEntry(operation.value);
      applyContextPathValue(merged, parsed.pathParts, parsed.value, "--set");
      continue;
    }

    if (operation.type === "json") {
      const parsed = parseJsonEntry(operation.value);
      Object.assign(merged, parsed);
      continue;
    }

    if (operation.type === "secret") {
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
  if (!isPlainObject(value)) {
    return;
  }

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

  if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

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
  for (let i = 0; i < pathParts.length; i += 1) {
    const key = pathParts[i];
    assertSafeContextKey(key, sourceLabel);
    const isLeaf = i === pathParts.length - 1;

    if (isLeaf) {
      current[key] = value;
      return;
    }

    const next = current[key];
    if (next === undefined || next === null) {
      current[key] = {};
      current = current[key];
      continue;
    }

    if (!isPlainObject(next)) {
      throw new Error(`Cannot set nested context path '${pathParts.join(".")}' because '${key}' is not an object.`);
    }

    current = next;
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

  const pathText = raw.slice(0, delimiterIndex).trim();
  const valueText = raw.slice(delimiterIndex + 1);
  const pathParts = pathText
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (pathParts.length === 0) {
    throw new Error(`Invalid --set entry '${raw}'. Missing key path.`);
  }

  return {
    pathParts,
    value: parseScalarInlineValue(valueText)
  };
}

function parseSecretEntry(entry, environment) {
  const raw = String(entry || "").trim();
  const equalsIndex = raw.indexOf("=");
  const path = parseSecretPath(equalsIndex < 0 ? raw : raw.slice(0, equalsIndex), "--secret");
  const environmentVariable = equalsIndex < 0
    ? secretEnvironmentVariable(path)
    : raw.slice(equalsIndex + 1).trim();
  return { path, value: readSecretEnvironmentVariable(environmentVariable, environment) };
}

function loadEnvironmentSecrets(environment) {
  const secrets = new Map();
  for (const [environmentVariable, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!environmentVariable.startsWith(SECRET_ENV_PREFIX)) {
      continue;
    }

    const path = parseSecretPath(environmentVariable.slice(SECRET_ENV_PREFIX.length).replaceAll("__", "."), environmentVariable);
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
  for (const key of pathParts) {
    assertSafeContextKey(key, sourceLabel);
  }

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
  if (!jsonText) {
    throw new Error("Invalid --json entry: value cannot be empty.");
  }

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

  if (!isPlainObject(parsed)) {
    throw new Error("Invalid --json entry: top-level value must be a JSON object.");
  }

  validateObjectKeys(parsed, "--json");
  return parsed;
}

async function loadPersonaText(personaFile) {
  if (!personaFile) {
    return "Default persona: pragmatic user with average technical comfort, prefers obvious and intuitive UI paths.";
  }

  const resolved = path.resolve(process.cwd(), personaFile);
  const content = await readFile(resolved, "utf8");
  return content.trim();
}

async function loadWorkspacePromptText(workspacePromptFile) {
  if (!workspacePromptFile) {
    return "";
  }

  const resolved = path.resolve(process.cwd(), workspacePromptFile);
  const content = await readFile(resolved, "utf8");
  return content.trim();
}

async function resolveScenarioText(config) {
  if (config.scenario && config.scenario.trim()) {
    return config.scenario.trim();
  }

  if (config.scenarioFile) {
    const resolved = path.resolve(process.cwd(), config.scenarioFile);
    const content = await readFile(resolved, "utf8");
    const prompt = content.trim();
    if (!prompt) {
      throw new Error(`Scenario file '${resolved}' is empty.`);
    }
    return prompt;
  }

  throw new Error("Missing scenario. Provide --scenario or --scenario-file.");
}

function getValueByPath(source, rawPath) {
  if (!rawPath) {
    return undefined;
  }

  const parts = rawPath
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

export function resolveFillValue(rawValue, contextData, humanInputs, secretValues = new Map()) {
  if (typeof rawValue !== "string") {
    throw new Error("Planner fill action value must be a string.");
  }

  const inputMatch = rawValue.match(/^\{\{input:([^}]+)\}\}$/);
  if (inputMatch) {
    const key = inputMatch[1].trim();
    const value = humanInputs.get(key);
    if (!value) {
      throw new Error(`Missing human input value for key '${key}'.`);
    }
    return value;
  }

  const contextMatch = rawValue.match(/^\{\{context:([^}]+)\}\}$/);
  if (contextMatch) {
    const contextPath = contextMatch[1].trim();
    let value = getValueByPath(contextData, contextPath);

    // Models sometimes include the outer prompt key (contextData.*) when
    // emitting placeholders. Accept both forms for resilience.
    if ((value === undefined || value === null) && contextPath.startsWith("contextData.")) {
      const trimmedPath = contextPath.slice("contextData.".length);
      value = getValueByPath(contextData, trimmedPath);
    }

    // Also tolerate a full payload-like path (payload.contextData.*).
    if ((value === undefined || value === null) && contextPath.startsWith("payload.contextData.")) {
      const trimmedPath = contextPath.slice("payload.contextData.".length);
      value = getValueByPath(contextData, trimmedPath);
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
  const values = new Set(secretValues.values());
  return redactSecretValue(value, values);
}

function redactSecretValue(value, secretValues) {
  if (typeof value === "string") {
    return secretValues.has(value) ? "*******" : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValue(entry, secretValues));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSecretValue(nested, secretValues)]));
}

async function collectObservation(page, observationConfig, turnToken) {
  return page.evaluate(({ config, turnToken: activeTurnToken }) => {
    const cfg = config && typeof config === "object" ? config : {};

    const controlsSelector =
      typeof cfg.controlsSelector === "string" && cfg.controlsSelector.trim().length > 0
        ? cfg.controlsSelector
        : "button, a, input, textarea, select, [role='button'], [role='link'], [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']";
    const maxControls = Number.isFinite(cfg.maxControls) ? Math.max(1, Number(cfg.maxControls)) : 80;
    const headingSelector =
      typeof cfg.headingSelector === "string" && cfg.headingSelector.trim().length > 0
        ? cfg.headingSelector
        : "h1, h2, h3";
    const maxHeadings = Number.isFinite(cfg.maxHeadings) ? Math.max(0, Number(cfg.maxHeadings)) : 10;
    const alertSelector =
      typeof cfg.alertSelector === "string" && cfg.alertSelector.trim().length > 0
        ? cfg.alertSelector
        : "[role='alert']";
    const maxAlerts = Number.isFinite(cfg.maxAlerts) ? Math.max(0, Number(cfg.maxAlerts)) : 6;
    const documentTextMaxChars = Number.isFinite(cfg.documentTextMaxChars)
      ? Math.max(1, Number(cfg.documentTextMaxChars))
      : 2400;
    const maxOptionsPerControl = Number.isFinite(cfg.maxOptionsPerControl)
      ? Math.max(1, Number(cfg.maxOptionsPerControl))
      : 30;

    const ignoreControlSelectors = Array.isArray(cfg.ignoreControlSelectors)
      ? cfg.ignoreControlSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const ignoreControlTextPatterns = Array.isArray(cfg.ignoreControlTextPatterns)
      ? cfg.ignoreControlTextPatterns.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const priorityControlSelectors = Array.isArray(cfg.priorityControlSelectors)
      ? cfg.priorityControlSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const documentTextScopeSelectors = Array.isArray(cfg.documentTextScopeSelectors)
      ? cfg.documentTextScopeSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];

    const normalizeText = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const resolveReferencedText = (ids) =>
      ids
        .split(/\s+/)
        .map((id) => globalThis.document.getElementById(id))
        .map((element) => normalizeText(element?.innerText || element?.textContent || ""))
        .filter(Boolean)
        .join(" · ");

    const queryAllWithin = (root, selector) => {
      try {
        return Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    };

    const isVisible = (el) => {
      const style = globalThis.window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const leafTextSegments = (el) => {
      const segments = [];
      const visit = (node) => {
        const children = Array.from(node.children || []).filter((child) => isVisible(child));
        if (children.length === 0) {
          const text = normalizeText(node.innerText || node.textContent || "");
          if (text) segments.push(text);
          return;
        }

        for (const child of children) visit(child);
      };
      visit(el);
      return [...new Set(segments)];
    };

    const resolveControlName = (el, textSegments) => {
      const labelledBy = resolveReferencedText(el.getAttribute("aria-labelledby") || "");
      if (labelledBy) return labelledBy;

      const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
      if (ariaLabel) return ariaLabel;

      if ("labels" in el && el.labels?.length) {
        const labels = Array.from(el.labels)
          .map((label) => normalizeText(label.innerText || label.textContent || ""))
          .filter(Boolean)
          .join(" · ");
        if (labels) return labels;
      }

      const id = el.getAttribute("id") || "";
      const associatedLabel = id
        ? normalizeText(globalThis.document.querySelector(`label[for='${globalThis.CSS.escape(id)}']`)?.innerText || "")
        : "";
      return associatedLabel || textSegments[0] || normalizeText(el.innerText || el.textContent || "");
    };

    const resolveContextPath = (el, scopeRoot) => {
      const parts = [];
      let current = el.parentElement;
      while (current && current !== scopeRoot.parentElement) {
        if (current === scopeRoot && current.getAttribute("role") === "dialog") {
          const title = resolveModalTitle(current);
          if (title) parts.unshift(title);
          break;
        }

        const role = current.getAttribute("role") || "";
        if (current.tagName === "FORM") {
          parts.unshift("form");
        } else if (current.tagName === "FIELDSET") {
          const legend = normalizeText(current.querySelector("legend")?.innerText || "");
          parts.unshift(legend || "fieldset");
        } else if (role === "group" || role === "region") {
          const name = resolveControlName(current, leafTextSegments(current));
          parts.unshift(name || role);
        }
        current = current.parentElement;
      }
      return [...new Set(parts)];
    };

    const resolveModalTitle = (modalEl) => {
      const labelledBy = modalEl.getAttribute("aria-labelledby") || "";
      if (labelledBy) {
        const heading = globalThis.document.getElementById(labelledBy);
        if (heading) {
          const text = normalizeText(heading.textContent || "");
          if (text) {
            return text;
          }
        }
      }

      const ariaLabel = normalizeText(modalEl.getAttribute("aria-label") || "");
      if (ariaLabel) {
        return ariaLabel;
      }

      const heading = queryAllWithin(modalEl, "h1, h2, h3, [role='heading']")
        .map((el) => normalizeText(el.textContent || ""))
        .find(Boolean);
      return heading || "";
    };

    const findActiveModal = () => {
      const selectors = [
        "[role='dialog'][aria-modal='true']",
        "dialog[open]",
        "[role='dialog'][data-state='open']",
        "[role='dialog']",
      ];

      const candidates = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const el of queryAllWithin(globalThis.document, selector)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!isVisible(el)) continue;
          candidates.push(el);
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      let best = candidates[0];
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const el of candidates) {
        const style = globalThis.window.getComputedStyle(el);
        const zIndex = Number.parseFloat(style.zIndex || "0");
        const rect = el.getBoundingClientRect();
        const area = Math.max(0, rect.width * rect.height);
        const score = (Number.isFinite(zIndex) ? zIndex : 0) * 1_000_000 + area;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }

      return best;
    };

    const activeModal = findActiveModal();

    const getVisibleClientRect = (el) => {
      const rect = el.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.left, globalThis.window.innerWidth));
      const right = Math.max(0, Math.min(rect.right, globalThis.window.innerWidth));
      const top = Math.max(0, Math.min(rect.top, globalThis.window.innerHeight));
      const bottom = Math.max(0, Math.min(rect.bottom, globalThis.window.innerHeight));

      if (right - left < 1 || bottom - top < 1) {
        return null;
      }

      return { left, right, top, bottom };
    };

    const isLayerClickable = (el) => {
      if (!isVisible(el)) {
        return false;
      }

      const style = globalThis.window.getComputedStyle(el);
      if (style.pointerEvents === "none") {
        return false;
      }

      const rect = getVisibleClientRect(el);
      if (!rect) {
        return false;
      }

      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      const topEl = globalThis.document.elementFromPoint(cx, cy);
      if (!topEl) {
        return false;
      }

      if (topEl === el || el.contains(topEl)) {
        return true;
      }

      const topLabel = topEl.closest("label");
      if (topLabel && "control" in topLabel && topLabel.control === el) {
        return true;
      }

      return false;
    };

    const allVisibleControls = queryAllWithin(globalThis.document, controlsSelector).filter((el) => isVisible(el));
    const visibleOutsideModalControls = activeModal
      ? allVisibleControls.filter((el) => !activeModal.contains(el))
      : [];
    const bodyStyle = globalThis.document.body
      ? globalThis.window.getComputedStyle(globalThis.document.body)
      : null;
    const modalBlocksBackground = Boolean(activeModal) && (
      activeModal.getAttribute("aria-modal") === "true" ||
      activeModal.matches("dialog[open]") ||
      globalThis.document.body?.hasAttribute("data-scroll-locked") ||
      bodyStyle?.pointerEvents === "none" ||
      (visibleOutsideModalControls.length > 0 &&
        !visibleOutsideModalControls.some((el) => isLayerClickable(el)))
    );
    const scopeRoot = modalBlocksBackground && activeModal ? activeModal : globalThis.document;
    const activeOverlayTriggers = queryAllWithin(
      scopeRoot,
      "[aria-expanded='true'][aria-controls], [aria-expanded='true'][aria-owns]"
    );
    const activeOverlayRoots = activeOverlayTriggers
      .flatMap((trigger) =>
        `${trigger.getAttribute("aria-controls") || ""} ${trigger.getAttribute("aria-owns") || ""}`
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => globalThis.document.getElementById(id))
      )
      .filter((overlay) => overlay && isVisible(overlay));
    const interactionRoots = [...new Set([scopeRoot, ...activeOverlayRoots])];
    const queryAllInteractionRoots = (selector) =>
      [...new Set(interactionRoots.flatMap((root) => queryAllWithin(root, selector)))];
    const overlayControlSelector = "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='treeitem']";
    const overlayControls = [...new Set(activeOverlayRoots.flatMap((root) => queryAllWithin(root, overlayControlSelector)))];
    const isActiveOverlayControl = (el) => overlayControls.includes(el);

    const matchesAnySelector = (el, selectors) =>
      selectors.some((selector) => {
        try {
          return el.matches(selector);
        } catch {
          return false;
        }
      });

    const shouldIgnoreControl = (el) => {
      if (matchesAnySelector(el, ignoreControlSelectors)) {
        return true;
      }

      if (ignoreControlTextPatterns.length === 0) {
        return false;
      }

      const candidate = normalizeText(
        `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`
      ).toLowerCase();

      return ignoreControlTextPatterns.some((pattern) => {
        try {
          return new RegExp(pattern, "i").test(candidate);
        } catch {
          return candidate.includes(pattern.toLowerCase());
        }
      });
    };

    const selectedElements = [];
    const seenElements = new Set();

    for (const el of overlayControls) {
      if (selectedElements.length >= maxControls) break;
      if (!isVisible(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: true });
    }

    for (const selector of priorityControlSelectors) {
      const nodes = queryAllInteractionRoots(selector);

      for (const el of nodes) {
        if (seenElements.has(el)) continue;
        if (!isVisible(el)) continue;
        if (!isActiveOverlayControl(el) && !isLayerClickable(el)) continue;
        if (shouldIgnoreControl(el)) continue;
        seenElements.add(el);
        selectedElements.push({ el, priority: true });
      }
    }

    let generalNodes = [];
    generalNodes = queryAllInteractionRoots(controlsSelector);

    for (const el of generalNodes) {
      if (selectedElements.length >= maxControls) break;
      if (seenElements.has(el)) continue;
      if (!isVisible(el)) continue;
      if (!isActiveOverlayControl(el) && !isLayerClickable(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: false });
    }

    for (const el of queryAllWithin(globalThis.document, "[data-agentic-id], [data-agentic-turn], [data-agentic-scroll-id]")) {
      el.removeAttribute("data-agentic-id");
      el.removeAttribute("data-agentic-turn");
      el.removeAttribute("data-agentic-scroll-id");
    }

    const scrollRoot = scopeRoot === globalThis.document ? globalThis.document.body : scopeRoot;
    const scrollableElements = [scrollRoot, ...queryAllWithin(scopeRoot, "*")].filter((el, index, elements) => {
      if (!el || elements.indexOf(el) !== index || !isVisible(el)) return false;
      const style = globalThis.window.getComputedStyle(el);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 1
      );
    });
    const scrollContainers = scrollableElements.map((el, index) => {
      const id = `s${index + 1}`;
      el.setAttribute("data-agentic-scroll-id", id);
      el.setAttribute("data-agentic-turn", activeTurnToken);
      return {
        id,
        contextPath: resolveContextPath(el, scopeRoot),
        canScrollUp: el.scrollTop > 1,
        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 1
      };
    });

    let sequence = 0;
    const visibleControls = selectedElements.map(({ el, priority }) => {
      sequence += 1;
      const agenticId = `a${sequence}`;
      el.setAttribute("data-agentic-id", agenticId);
      el.setAttribute("data-agentic-turn", activeTurnToken);

      const textSegments = leafTextSegments(el);
      const text = textSegments.join(" · ") || normalizeText(el.innerText || el.textContent || "");
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const label = resolveControlName(el, textSegments);
      const description = resolveReferencedText(el.getAttribute("aria-describedby") || "");
      const disabled =
        ("disabled" in el && Boolean(el.disabled)) || el.getAttribute("aria-disabled") === "true" || false;

      let value = "";
      let hasValue = false;
      let checked = el.getAttribute("aria-checked") === "true";

      if (tag === "input") {
        const input = /** @type {HTMLInputElement} */ (el);
        checked = Boolean(input.checked);

        if (type === "checkbox" || type === "radio") {
          hasValue = true;
          value = checked ? "checked" : "unchecked";
        } else {
          value = input.value || "";
          hasValue = value.length > 0;
        }
      } else if (tag === "textarea") {
        const textarea = /** @type {HTMLTextAreaElement} */ (el);
        value = textarea.value || "";
        hasValue = value.length > 0;
      } else if (tag === "select") {
        const select = /** @type {HTMLSelectElement} */ (el);
        value = select.value || "";
        hasValue = value.length > 0;
      } else if (el.getAttribute("contenteditable") === "true") {
        value = text;
        hasValue = value.length > 0;
      }

      const options = tag === "select"
        ? Array.from(/** @type {HTMLSelectElement} */ (el).options)
            .map((option) => ({
              label: normalizeText(option.label || option.textContent || ""),
              value: option.value,
              ...(option.selected ? { selected: true } : {}),
              ...(option.disabled ? { disabled: true } : {})
            }))
            .filter((option) => option.label || option.value)
            .slice(0, maxOptionsPerControl)
        : [];

      return {
        id: agenticId,
        tag,
        role,
        type,
        priority,
        text,
        ariaLabel,
        label,
        ...(description ? { description } : {}),
        contextPath: resolveContextPath(el, scopeRoot),
        placeholder,
        ...(value ? { value } : {}),
        ...(options.length > 0 ? { options } : {}),
        hasValue,
        checked,
        ...(el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? { required: true } : {}),
        ...(el.getAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
        ...(el.getAttribute("aria-selected") ? { selected: el.getAttribute("aria-selected") === "true" } : {}),
        ...(el.getAttribute("aria-pressed") ? { pressed: el.getAttribute("aria-pressed") === "true" } : {}),
        ...(el.getAttribute("aria-current") ? { current: el.getAttribute("aria-current") } : {}),
        ...(el.getAttribute("aria-invalid") === "true" ? { invalid: true } : {}),
        ...(disabled ? { disabled: true } : {}),
      };
    });

    const headings = queryAllWithin(scopeRoot, headingSelector)
      .map((el) => normalizeText(el.textContent || ""))
      .filter(Boolean)
      .slice(0, maxHeadings);

    const alerts = queryAllWithin(scopeRoot, alertSelector)
      .map((el) => normalizeText(el.textContent || ""))
      .filter(Boolean)
      .slice(0, maxAlerts);

    let textRoot = null;
    if (modalBlocksBackground && activeModal) {
      textRoot = activeModal;
    } else if (documentTextScopeSelectors.length > 0) {
      for (const selector of documentTextScopeSelectors) {
        const nodes = queryAllWithin(globalThis.document, selector);

        const firstVisibleNode = nodes.find((node) => isVisible(node));
        if (firstVisibleNode) {
          textRoot = firstVisibleNode;
          break;
        }
      }
    }

    if (!textRoot && globalThis.document.body) {
      textRoot = globalThis.document.body;
    }
    let documentText = "";
    if (textRoot) {
      documentText = normalizeText(typeof textRoot.innerText === "string" ? textRoot.innerText : "");
    }

    documentText = documentText.slice(0, documentTextMaxChars);

    return {
      url: globalThis.window.location.href,
      title: globalThis.document.title,
      modal: {
        open: Boolean(activeModal),
        blocksBackground: modalBlocksBackground,
        role: activeModal?.getAttribute("role") || "",
        ariaModal: activeModal?.getAttribute("aria-modal") || "",
        title: activeModal ? resolveModalTitle(activeModal) : "",
      },
      headings,
      alerts,
      documentText,
      scrollContainers,
      controls: visibleControls,
    };
  }, { config: observationConfig, turnToken });
}

export function buildPlannerMessages({
  testPrompt,
  personaText,
  workspacePromptText,
  contextData,
  observation,
  actionHistory,
  humanInputs,
  secretValues = new Map(),
  screenshotRequested,
  strictTargetSelectors = false,
}) {
  const redactedObservation = redactSecretValues(observation, secretValues);
  const compactControls = redactedObservation.controls.map((control) => ({
    id: control.id,
    tag: control.tag,
    role: control.role,
    type: control.type,
    priority: control.priority,
    text: clip(control.text),
    label: clip(control.label),
    ariaLabel: clip(control.ariaLabel),
    placeholder: clip(control.placeholder),
    ...(control.description ? { description: clip(control.description) } : {}),
    ...(control.contextPath?.length ? { contextPath: control.contextPath } : {}),
    ...(control.value ? { value: clip(control.value) } : {}),
    ...(control.options ? { options: control.options } : {}),
    hasValue: control.hasValue,
    checked: control.checked,
    required: Boolean(control.required),
    ...(typeof control.expanded === "boolean" ? { expanded: control.expanded } : {}),
    ...(typeof control.selected === "boolean" ? { selected: control.selected } : {}),
    ...(typeof control.pressed === "boolean" ? { pressed: control.pressed } : {}),
    ...(control.current ? { current: control.current } : {}),
    invalid: Boolean(control.invalid),
    disabled: Boolean(control.disabled),
  }));

  const history = actionHistory.slice(-10);
  const completedWork = actionHistory
    .filter(({ outcome, action }) => outcome === "ok" && !["scroll", "request_screenshot"].includes(action.payload.action))
    .map(({ step, action, target }) => ({
      step,
      action: action.payload.action,
      ...(target ? { target } : {}),
      ...(action.payload.action === "fill" ? { value: action.payload.value } : {}),
      ...(action.payload.action === "select_option" ? { value: action.payload.value } : {}),
      reason: clip(action.reason, 240),
    }));
  const knownHumanInputs = Object.fromEntries(humanInputs.entries());

  const staticContext = {
    contextData,
    ...(secretValues.size > 0 ? { availableSecretPaths: [...secretValues.keys()] } : {}),
    planningRules: [
      "Use visible controls only.",
      "Always provide a non-empty reason for the chosen action.",
      "If observation.modal.blocksBackground is true, only interact with controls listed from the blocking modal context.",
      "If observation.modal.open is true but observation.modal.blocksBackground is false, you may still use background controls when needed.",
      "Do not invent element IDs.",
      "For click and fill actions, always provide a target object that matches exactly one visible control.",
      strictTargetSelectors
        ? "Use only the visible control ID as the target selector, for example { id: 'a3' }."
        : "The lightweight selector { id: 'a3' } is acceptable and preferred by default. You may combine any visible control fields when needed to identify one control.",
      "Put action and action-specific fields in payload; keep reason at the root.",
      "Never emit click or fill without target.",
      "For fill actions, also provide a value.",
      "Treat checked, selected, and pressed as current control state. Do not click a control that is already in the state required by the objective.",
      "Use select_option only for an observed native select that includes an options list, using an observed option value. For an open custom combobox, click the visible role=option control instead.",
      "When an observed scroll container has canScrollDown or canScrollUp, use scroll with its containerId and direction to reveal more content before escalating.",
      "completedWork is a durable record of successful work from this run. Do not scroll only to re-verify completed work; use the current observation and completedWork to decide what remains.",
      "A successful submit or save followed by visible confirmation of the saved item is sufficient persistence evidence. Do not reopen a saved item merely to inspect settings already recorded in completedWork unless the objective explicitly requires post-save verification or visible evidence contradicts it.",
      "Before finishing, do not try to audit every part of a long form from one viewport. Combine current visible evidence with completedWork; if all success criteria are covered, finish instead of alternating scroll directions.",
      ...(secretValues.size > 0
        ? ["Secret values are unavailable. Fill registered secrets with {{secret:path}}, using a path from availableSecretPaths."]
        : []),
      "Do not use the 'Continue with Google' login because the Google page will not load properly in this browser.",
      "Do not fill the same field with a different value unless visible validation or error evidence shows correction is needed.",
      "Use observation.documentText as the main source of visible page text when deciding whether login or onboarding is still loading or has finished.",
      "The runner automatically waits for ordinary UI transitions to settle before each observation; do not wait merely to pause after an action.",
      "After a click or fill, do not repeat it based on an earlier observation. If its target is absent or disabled in the current observation, the UI is transitioning.",
      "When a persistent transition leaves an old screen visible but its submit control is absent or disabled, use wait_until_gone with expectGone.documentText set to visible text from that old screen which must disappear.",
      "Do not repeat the same wait_until_gone condition unless a UI action or URL change has occurred.",
      "Do not return finish while the UI appears to be loading or transitioning.",
      "Before finish, verify visible evidence for the success criteria in the test prompt.",
      "Use give_up with a specific reason only after exhausting credible actions and no safe or reliable path to the objective remains.",
      "When the objective is completed, return finish.",
    ],
    humanEscalationRules: [
      "If you need a value not deducible from UI or contextData, such as an OTP code, use request_user_input.",
      "If you are blocked and need the human to do something in the browser, use request_user_interaction.",
      "If the structured observation is insufficient, use request_screenshot.",
    ],
  };

  const dynamicContext = {
    knownHumanInputs,
    observation: {
      url: redactedObservation.url,
      title: redactedObservation.title,
      modal: redactedObservation.modal,
      headings: redactedObservation.headings,
      alerts: redactedObservation.alerts,
      documentText: clip(redactedObservation.documentText, 1600),
      scrollContainers: redactedObservation.scrollContainers || [],
      controls: compactControls,
    },
    screenshotRequested,
    completedWork: redactSecretValues(completedWork, secretValues),
    recentActions: history,
  };

  const systemText = [
    "You are an autonomous UX test agent driving a browser.",
    "Decide one next action at a time using only visible elements from the observation.",
    "Favor intuitive user behavior and avoid hidden shortcuts.",
    "Use the planner_action tool on every turn instead of replying with free text.",
    ...(workspacePromptText
      ? [
          "Application-specific background and testing instructions (apply throughout the run):",
          workspacePromptText,
        ]
      : []),
    "Persona instructions (apply throughout the run):",
    personaText,
    "Scenario objective and success criteria (apply throughout the run):",
    testPrompt,
  ].join(" ");

  const staticContextText = JSON.stringify({ staticContext }, null, 2);
  const dynamicContextText = JSON.stringify({ turnContext: dynamicContext }, null, 2);

  return {
    systemText,
    staticContextText,
    dynamicContextText,
    debugUserText: [staticContextText, dynamicContextText].join("\n\n"),
  };
}

async function requestPlannerActionBedrock({ client, modelId, llmConfig, messages, screenshotBuffer }) {
  const supportsPromptCaching = modelSupportsBedrockPromptCaching(modelId);
  const userContent = [{ text: messages.staticContextText }];
  if (supportsPromptCaching) {
    userContent.push({
      cachePoint: {
        type: "default",
      },
    });
  }
  userContent.push({ text: messages.dynamicContextText });
  if (screenshotBuffer) {
    userContent.push({
      image: {
        format: "png",
        source: {
          bytes: screenshotBuffer,
        },
      },
    });
  }

  const toolConfig = plannerBedrockToolSpec(llmConfig);

  const plannerInferenceConfig = buildBedrockInferenceConfig(llmConfig, 700);
  const additionalModelRequestFields = getBedrockAdditionalModelRequestFields(llmConfig);

  const buildCommandInput = (includeServiceTier) => ({
    modelId,
    ...(includeServiceTier && toBedrockRequestServiceTier(llmConfig?.serviceTier)
      ? { serviceTier: toBedrockRequestServiceTier(llmConfig?.serviceTier) }
      : {}),
    system: [{ text: messages.systemText }],
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
    ...(plannerInferenceConfig ? { inferenceConfig: plannerInferenceConfig } : {}),
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    toolConfig,
    toolChoice: {
      tool: {
        name: "planner_action",
      },
    },
  });

  let result;
  try {
    result = await client.send(new ConverseCommand(buildCommandInput(true)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (toBedrockRequestServiceTier(llmConfig?.serviceTier) && /unexpected field type/i.test(detail)) {
      try {
        result = await client.send(new ConverseCommand(buildCommandInput(false)));
      } catch {
        throw new Error(`Bedrock planner call failed for model '${modelId}': ${detail}`);
      }
    } else {
      throw new Error(`Bedrock planner call failed for model '${modelId}': ${detail}`);
    }
  }

  const tokenUsage = normalizeTokenUsage(result?.usage);
  if (tokenUsage.totalTokens === 0) {
    tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
  }

  const contentItems = result.output?.message?.content || [];
  const toolUseItem = contentItems.find((item) => item.toolUse?.name === "planner_action");
  if (toolUseItem?.toolUse?.input && typeof toolUseItem.toolUse.input === "object") {
    return {
      parsed: toolUseItem.toolUse.input,
      tokenUsage,
    };
  }

  const textContent = contentItems
    .map((item) => item.text || "")
    .join("\n")
    .trim();
  if (!textContent) {
    throw new Error("Bedrock planner API returned no content.");
  }

  // Fallback for models that ignore tool selection and return prose with embedded JSON.
  let parsed;
  try {
    const parsedContent = extractJsonFromText(textContent);
    parsed = JSON.parse(parsedContent);
  } catch {
    parsed = extractFirstJsonObjectFromText(textContent);
  }

  return {
    parsed,
    tokenUsage,
  };
}

async function requestPlannerAction({ planner, messages, screenshotBuffer, signal }) {
  return planner.nextAction({
    messages,
    ...(screenshotBuffer ? { screenshot: screenshotBuffer } : {}),
    ...(signal ? { signal } : {}),
  });
}

async function runBedrockPreflight({ client, modelId, llmConfig }) {
  const preflightInferenceConfig = buildBedrockInferenceConfig(llmConfig, 20);
  const additionalModelRequestFields = getBedrockAdditionalModelRequestFields(llmConfig);

  const buildCommandInput = (includeServiceTier) => ({
    modelId,
    ...(includeServiceTier && toBedrockRequestServiceTier(llmConfig?.serviceTier)
      ? { serviceTier: toBedrockRequestServiceTier(llmConfig?.serviceTier) }
      : {}),
    messages: [
      {
        role: "user",
        content: [{ text: 'Return exactly this JSON: {"ok":true}' }],
      },
    ],
    ...(preflightInferenceConfig ? { inferenceConfig: preflightInferenceConfig } : {}),
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  });

  try {
    await client.send(new ConverseCommand(buildCommandInput(true)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (toBedrockRequestServiceTier(llmConfig?.serviceTier) && /unexpected field type/i.test(detail)) {
      try {
        await client.send(new ConverseCommand(buildCommandInput(false)));
        return;
      } catch {
        // Fall through to throw original detail.
      }
    }
    throw new Error(
      `Bedrock preflight failed for model '${modelId}'. Check AWS credentials/region/model access. Detail: ${detail}`
    );
  }
}

async function requestPlannerActionOpenAI({ baseUrl, modelId, apiKey, messages, screenshotBuffer }) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/chat/completions`;

  const userContent = [
    { type: "text", text: messages.staticContextText },
    { type: "text", text: messages.dynamicContextText },
  ];

  if (screenshotBuffer) {
    const base64 = screenshotBuffer.toString("base64");
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${base64}` },
    });
  }

  const toolSpec = plannerOpenAIToolSpec();

  const body = {
    model: modelId,
    messages: [
      { role: "system", content: messages.systemText },
      { role: "user", content: userContent },
    ],
    tools: toolSpec.tools,
    tool_choice: toolSpec.tool_choice,
    max_tokens: 700,
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = "Bearer " + apiKey;
  }

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI-compatible planner call failed for model '${modelId}' at '${baseUrl}': ${detail}`);
  }

  if (!response.ok) {
    let errorDetail;
    try {
      errorDetail = (await response.text()).slice(0, 200);
    } catch {
      errorDetail = `HTTP ${response.status}`;
    }
    throw new Error(`OpenAI-compatible planner call failed for model '${modelId}' at '${baseUrl}': ${errorDetail}`);
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI-compatible planner response was not valid JSON for model '${modelId}': ${detail}`);
  }

  const tokenUsage = normalizeOpenAITokenUsage(result?.usage);

  // Try structured tool call first.
  const toolCall = result?.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    let parsed;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      parsed = extractFirstJsonObjectFromText(toolCall.function.arguments);
    }
    return { parsed, tokenUsage };
  }

  // Fallback: extract JSON from prose response.
  const textContent = String(result?.choices?.[0]?.message?.content || "").trim();
  if (!textContent) {
    throw new Error("OpenAI-compatible planner API returned no content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJsonFromText(textContent));
  } catch {
    parsed = extractFirstJsonObjectFromText(textContent);
  }

  return { parsed, tokenUsage };
}

function buildBedrockInferenceConfig(llmConfig, defaultMaxTokens) {
  const configured = isPlainObject(llmConfig?.inferenceConfig) ? llmConfig.inferenceConfig : {};
  const merged = {
    maxTokens: defaultMaxTokens,
    ...configured,
  };

  const normalized = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && value !== null)
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getBedrockAdditionalModelRequestFields(llmConfig) {
  const value = llmConfig?.additionalModelRequestFields;
  if (!isPlainObject(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toBedrockRequestServiceTier(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "default") {
    return undefined;
  }
  if (["priority", "flex", "reserved"].includes(normalized)) {
    return normalized;
  }
  return undefined;
}

async function runOpenAIPreflight({ baseUrl, modelId, apiKey }) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/chat/completions`;

  const body = {
    model: modelId,
    messages: [{ role: "user", content: 'Return exactly this JSON: {"ok":true}' }],
    max_tokens: 20,
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = "Bearer " + apiKey;
  }

  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenAI-compatible preflight failed for model '${modelId}' at '${baseUrl}'. Check that the server is running and the model is available. Detail: ${detail}`
    );
  }
}

async function waitForUiSettle(page, settleDelayMs, settleTimeoutMs) {
  const minStableMs = Number.isFinite(settleDelayMs) ? Math.max(1, Number(settleDelayMs)) : 500;
  const maxWaitMs = Number.isFinite(settleTimeoutMs) ? Math.max(minStableMs, Number(settleTimeoutMs)) : 3000;
  const pollMs = 120;

  const startedAt = Date.now();
  let stableSince = Date.now();
  let previousSignature = "";

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(1200, maxWaitMs) });
  } catch {
    // Ignore timeout; SPA transitions do not always trigger load states.
  }

  while (Date.now() - startedAt < maxWaitMs) {
    const signature = await page.evaluate(() => {
      const controls = Array.from(
        globalThis.document.querySelectorAll(
          "button, a, input, textarea, select, [role='button'], [role='link'], [contenteditable='true']"
        )
      )
        .filter((el) => {
          const style = globalThis.window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 40)
        .map((el) => {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
          const ariaLabel = (el.getAttribute("aria-label") || "").slice(0, 40);
          const disabled =
            ("disabled" in el && Boolean(el.disabled)) || el.getAttribute("aria-disabled") === "true" || false;
          return `${el.tagName}:${disabled ? "1" : "0"}:${text}:${ariaLabel}`;
        })
        .join("|");

      const alerts = Array.from(globalThis.document.querySelectorAll("[role='alert']"))
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80))
        .join("|");

      return `${globalThis.window.location.href}::${globalThis.document.title}::${controls}::${alerts}`;
    });

    if (signature !== previousSignature) {
      previousSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= minStableMs) {
      return;
    }

    await page.waitForTimeout(pollMs);
  }
}

function normalizeDocumentText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function isDocumentTextGone(documentText, expectedText) {
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
  const normalizedDocumentText = normalizeDocumentText(documentText);
  return expectedTexts.every(
    (item) => !normalizedDocumentText.includes(normalizeDocumentText(item))
  );
}

function normalizeTargetValue(value) {
  return typeof value === "string" ? normalizeDocumentText(value) : value;
}

export function resolveTargetControl(controls, targetSelector) {
  const selectorEntries = Object.entries(targetSelector || {});
  const matches = controls.filter((control) =>
    selectorEntries.every(([key, expectedValue]) => {
      const actualValue = key === "disabled" ? Boolean(control.disabled) : control[key];
      return normalizeTargetValue(actualValue) === normalizeTargetValue(expectedValue);
    })
  );

  if (matches.length === 1) {
    return matches[0];
  }

  const selectorText = JSON.stringify(targetSelector);
  if (matches.length === 0) {
    throw new Error(`Planner target not found: ${selectorText}`);
  }
  throw new Error(`Planner target selector is ambiguous: ${selectorText} matched ${matches.length} controls.`);
}

function describeTarget(target) {
  return target ? JSON.stringify(target) : "none";
}

function formatExpectedDocumentText(expectedText) {
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
  return expectedTexts.map((item) => normalizeDocumentText(item)).join("|");
}

async function waitForDocumentTextGone(page, expectedText, settleDelayMs, settleTimeoutMs) {
  const startedAt = Date.now();
  const pollMs = 120;
  let absentSince = null;
  let latestDocumentText = "";

  while (Date.now() - startedAt < settleTimeoutMs) {
    latestDocumentText = await page.evaluate(() =>
      String(globalThis.document.body?.innerText || "").replace(/\s+/g, " ").trim()
    );

    if (isDocumentTextGone(latestDocumentText, expectedText)) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= settleDelayMs) {
        return { completed: true, latestDocumentText };
      }
    } else {
      absentSince = null;
    }

    await page.waitForTimeout(pollMs);
  }

  return { completed: false, latestDocumentText };
}

export async function runScenario(config, options = {}) {
  const startedAt = new Date();
  const shouldInterrupt = typeof options.shouldInterrupt === "function" ? options.shouldInterrupt : () => false;
  let browserClosed = false;

  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) {
    throw new Error("--max-steps must be a positive number");
  }
  if (!Number.isInteger(config.settleDelayMs) || config.settleDelayMs < 1) {
    throw new Error("--settle-delay-ms must be a positive integer");
  }
  if (!Number.isInteger(config.settleTimeoutMs) || config.settleTimeoutMs < config.settleDelayMs) {
    throw new Error("--settle-timeout-ms must be a positive integer greater than or equal to --settle-delay-ms");
  }

  const throwIfInterrupted = () => {
    if (shouldInterrupt() || browserClosed) {
      throw createInterruptError(browserClosed ? "Browser was closed." : "Interrupted by Ctrl-C.");
    }
  };

  const { contextData, secretValues } = await loadContextFromOperations(config.contextOperations);
  const personaText = await loadPersonaText(config.personaFile);
  const workspacePromptText = await loadWorkspacePromptText(config.workspacePromptFile);
  const scenario = await resolveScenarioText(config);
  const observationConfig = await loadObservationConfig(config.observationConfigFile);
  const screenshots = normalizeScreenshotMode(config.screenshots);

  const runLabel = resolveRunLabel(config);
  let runId = createRunId(startedAt, "pending", runLabel);
  let runDir = path.join(config.outputDir, runId);
  const screenshotsDir = path.join(runDir, "screenshots");

  await mkdir(screenshotsDir, { recursive: true });

  const report = {
    runId,
    objective: scenario,
    config: {
      baseUrl: config.baseUrl,
      headed: config.headed,
      debug: config.debug,
      llm: config.llm,
      maxSteps: config.maxSteps,
      settleDelayMs: config.settleDelayMs,
      settleTimeoutMs: config.settleTimeoutMs,
      contextOperations: config.contextOperations,
      workspacePromptFile: config.workspacePromptFile,
      personaFile: config.personaFile,
      scenarioFile: config.scenarioFile,
      observationConfigFile: config.observationConfigFile,
      screenshots,
      reports: Array.isArray(config.reports) ? config.reports : [],
      initBlocks: Array.isArray(config.initBlocks) ? config.initBlocks.map((block) => block.name) : [],
    },
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    status: "running",
    finalUrl: "",
    tokenUsage: {
      provider: config.llm.provider,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      plannerCalls: 0,
    },
    pricing: null,
    costEstimate: null,
    steps: [],
    artifactsDir: runDir,
  };

  const planner =
    config.llm.provider === "openai-compatible"
      ? createOpenAICompatiblePlanner({
          baseUrl: config.llm.baseUrl,
          modelId: config.llm.modelId,
          ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
        })
      : createBedrockPlanner({
          modelId: config.llm.modelId,
          region: config.llm.region,
          ...(config.llm.inferenceConfig ? { inferenceConfig: config.llm.inferenceConfig } : {}),
          ...(config.llm.additionalModelRequestFields
            ? { additionalModelRequestFields: config.llm.additionalModelRequestFields }
            : {}),
          ...(config.llm.serviceTier ? { serviceTier: config.llm.serviceTier } : {}),
          ...(config.llm.supportsConditionalToolSchemas !== undefined
            ? { supportsConditionalToolSchemas: config.llm.supportsConditionalToolSchemas }
            : {}),
          ...(config.llm.supportsStrictToolUse !== undefined
            ? { supportsStrictToolUse: config.llm.supportsStrictToolUse }
            : {}),
        });

  const logger = createRunnerLogger(config.headed);
  const debugLogger = createDebugLogger(config.debug);
  const interactionProvider = createTerminalInteractionProvider();
  const formatObservationSummary = (observation) => {
    const visibleButtons = observation.controls.filter((control) => control.tag === "button").length;
    const visibleInputs = observation.controls.filter((control) => control.tag === "input").length;
    const visibleAlerts = observation.alerts.length;
    return `${observation.title || "untitled"} | ${observation.url} | controls=${observation.controls.length} buttons=${visibleButtons} inputs=${visibleInputs} alerts=${visibleAlerts}`;
  };

  const providerLabel = config.llm.provider === "openai-compatible"
    ? `openai-compatible:${config.llm.modelId}`
    : `bedrock:${config.llm.modelId}`;

  logger.info(`starting run ${runId} using ${providerLabel}`);

  logger.info(`running ${config.llm.provider} preflight against model ${config.llm.modelId}`);
  if (shouldInterrupt()) {
    return {
      status: "interrupted",
      error: "Interrupted by Ctrl-C."
    };
  }
  await planner.preflight();
  logger.info(`${config.llm.provider} preflight succeeded`);

  if (shouldInterrupt()) {
    return {
      status: "interrupted",
      error: "Interrupted by Ctrl-C."
    };
  }

  const browserSession = await createPlaywrightBrowserFactory().launch({
    headed: config.headed,
    viewport: { width: 1440, height: 900 },
  });
  const { page } = browserSession;
  const plannerAbortController = new AbortController();
  page.once("close", () => {
    browserClosed = true;
    plannerAbortController.abort();
  });

  const currentPageUrl = () => {
    try {
      return browserClosed ? "" : page.url();
    } catch {
      return "";
    }
  };

  let stepIndex = 0;
  const actionHistory = [];
  const humanInputs = new Map();
  let observationTurn = 0;
  let lastUiActionAt = 0;
  let pendingInteractionRequest = null;
  let pendingScreenshotBuffer = null;
  let previousTimedOutWait = null;

  const captureViewportScreenshot = async (options = {}) => {
    throwIfInterrupted();
    return page.screenshot({
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      ...options,
    });
  };

  const captureArtifactScreenshot = async (options = {}) => {
    throwIfInterrupted();
    if (screenshots === "fullpage") {
      return page.screenshot({
        fullPage: true,
        animations: "disabled",
        caret: "hide",
        ...options,
      });
    }

    return captureViewportScreenshot(options);
  };

  async function captureStep(name, plannerAction, execute, stepDebugContext = undefined, metadata = undefined) {
    throwIfInterrupted();
    stepIndex += 1;
    const artifactBase = `${String(stepIndex).padStart(2, "0")}-${sanitizeSegment(name)}`;
    const screenshotName = `${artifactBase}.png`;
    const htmlName = `${artifactBase}.html`;
    const screenshotPath = path.join(screenshotsDir, screenshotName);
    const htmlPath = path.join(screenshotsDir, htmlName);
    const started = Date.now();

    let stepError = null;
    let stepScreenshotRelativePath;
    let stepHtmlRelativePath;
    try {
      await execute();
      throwIfInterrupted();
    } catch (error) {
      stepError = errorMessage(error);
      throw error;
    } finally {
      if (screenshots !== "none" && !browserClosed) {
        await page.waitForTimeout(120);
        await captureArtifactScreenshot({ path: screenshotPath });
        stepScreenshotRelativePath = path.relative(runDir, screenshotPath);
      }

      if (config.debug && !browserClosed) {
        const html = await page.content();
        await writeFile(htmlPath, html, "utf8");
        stepHtmlRelativePath = path.relative(runDir, htmlPath);
      }

      report.steps.push({
        index: stepIndex,
        name,
        durationMs: Date.now() - started,
        url: page.url(),
        screenshot: stepScreenshotRelativePath,
        html: stepHtmlRelativePath,
        plannerAction,
        observation: stepDebugContext?.observation,
        knownHumanInputs: stepDebugContext?.knownHumanInputs,
        plannerTokenUsage: stepDebugContext?.plannerTokenUsage,
        phase: metadata?.phase,
        initBlock: metadata?.initBlock,
        outcome: stepError ? "error" : "ok",
        error: stepError || undefined,
      });
    }
  }

  async function executeDeterministicAction(action, observation, turnToken) {
    const payload = action.payload;
    if (payload.action === "wait_until_gone") {
      const expectedText = payload.expectGone.documentText;
      const waitResult = await waitForDocumentTextGone(
        page,
        expectedText,
        config.settleDelayMs,
        config.settleTimeoutMs
      );
      if (!waitResult.completed) {
        throw new Error(
          `Timed out waiting for document text to disappear: '${formatExpectedDocumentText(expectedText)}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`
        );
      }
      return;
    }

    const matchedControl = resolveTargetControl(observation.controls, payload.target);
    const target = page
      .locator(`[data-agentic-turn="${turnToken}"][data-agentic-id="${matchedControl.id}"]`)
      .first();
    if ((await target.count()) === 0) {
      throw new Error(`Block target not found: ${describeTarget(payload.target)}`);
    }

    if (payload.action === "click") {
      if (await isTargetDisabled(target)) {
        throw new Error(`Disabled target before click: ${describeTarget(payload.target)}`);
      }
      await target.click({ timeout: 1500 });
    } else if (payload.action === "fill") {
      await target.fill(resolveFillValue(payload.value, contextData, humanInputs, secretValues));
    } else {
      throw new Error(`Unsupported initialization action: ${payload.action}`);
    }

    throwIfInterrupted();
    lastUiActionAt = Date.now();
    pendingInteractionRequest = null;
    await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
  }

  try {
    throwIfInterrupted();

    await captureStep("open_start_page", undefined, async () => {
      throwIfInterrupted();
      logger.info(`navigating to ${config.baseUrl}`);
      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
    });

    for (const block of config.initBlocks || []) {
      logger.info(`replaying initialization block '${block.name}'`);
      for (const action of block.actions) {
        throwIfInterrupted();
        await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
        observationTurn += 1;
        const turnToken = `t${observationTurn}`;
        const observation = await collectObservation(page, observationConfig, turnToken);
        await captureStep(
          `init_${sanitizeSegment(block.name)}_${action.payload.action}`,
          action,
          () => executeDeterministicAction(action, observation, turnToken),
          config.debug ? { observation: redactSecretValues(observation, secretValues) } : undefined,
          { phase: "init", initBlock: block.name }
        );
      }
    }

    for (let i = 0; i < config.maxSteps; i += 1) {
      throwIfInterrupted();
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
      observationTurn += 1;
      const turnToken = `t${observationTurn}`;
      const observation = await collectObservation(page, observationConfig, turnToken);
      throwIfInterrupted();
      logger.info(`observation ${i + 1}: ${formatObservationSummary(observation)}`);

      const screenshotBufferForThisTurn = pendingScreenshotBuffer;
      pendingScreenshotBuffer = null;
      const knownHumanInputsSnapshot = Object.fromEntries(humanInputs.entries());

      const messages = buildPlannerMessages({
        testPrompt: scenario,
        personaText,
        workspacePromptText,
        contextData,
        secretValues,
        observation,
        actionHistory,
        humanInputs,
        screenshotRequested: Boolean(screenshotBufferForThisTurn),
        strictTargetSelectors: config.llm.supportsStrictToolUse === true,
      });

      debugLogger.log(
        `planner_input_step=${i + 1} provider=${config.llm.provider} hasScreenshot=${Boolean(screenshotBufferForThisTurn)}`
      );
      debugLogger.log("planner_system_begin");
      debugLogger.log(messages.systemText);
      debugLogger.log("planner_system_end");
      debugLogger.log("planner_user_begin");
      debugLogger.log(messages.debugUserText);
      debugLogger.log("planner_user_end");

      const plannerResult = await requestPlannerAction({
        planner,
        messages,
        screenshotBuffer: screenshotBufferForThisTurn,
        signal: plannerAbortController.signal,
      });

      throwIfInterrupted();

      const { tokenUsage: plannerTokenUsage, action: plannerAction } = plannerResult;

      if (plannerTokenUsage) {
        addTokenUsageTotals(report.tokenUsage, plannerTokenUsage);
      }

      const plannerPayload = plannerAction.payload;

      logger.info(
        `planner action ${i + 1}: ${plannerPayload.action}${plannerPayload.action === "click" || plannerPayload.action === "fill" || plannerPayload.action === "select_option" ? ` target=${describeTarget(plannerPayload.target)}` : ""} reason=${clip(plannerAction.reason, 140)}`
      );

      const actionName = `${plannerPayload.action}_${("target" in plannerPayload
        ? plannerPayload.target.id
        : "containerId" in plannerPayload
          ? plannerPayload.containerId
          : "selector")}`;

      let recoverableOutcome = null;
      let recoverableErrorMessage = "";
      let actionTarget;
      const stepDebugContext = config.debug
        ? {
            observation: redactSecretValues(observation, secretValues),
            knownHumanInputs: knownHumanInputsSnapshot,
            plannerTokenUsage,
          }
        : undefined;

      try {
      await captureStep(
        actionName,
        plannerAction,
        async () => {
          throwIfInterrupted();
          if (plannerPayload.action === "finish") {
            logger.info(`finish accepted at ${page.url()}`);
            report.status = "passed";
            report.finalUrl = page.url();
            return;
          }

          if (plannerPayload.action === "give_up") {
            report.status = "failed";
            report.finalUrl = page.url();
            report.error = `Planner gave up: ${plannerAction.reason}`;
            logger.warn(report.error);
            return;
          }

          if (plannerPayload.action === "wait_until_gone") {
            const expectedText = plannerPayload.expectGone.documentText;
            const formattedExpectedText = formatExpectedDocumentText(expectedText);
            const waitKey = `${page.url()}::${formattedExpectedText}`;
            if (previousTimedOutWait === waitKey) {
              recoverableOutcome = "duplicate_wait";
              recoverableErrorMessage = `The same wait_until_gone condition already timed out without a URL change: '${formattedExpectedText}'.`;
              logger.warn(recoverableErrorMessage);
              return;
            }

            logger.info(`waiting for document text to disappear: ${clip(formattedExpectedText)}`);
            const waitResult = await waitForDocumentTextGone(
              page,
              expectedText,
              config.settleDelayMs,
              config.settleTimeoutMs
            );
            if (!waitResult.completed) {
              previousTimedOutWait = waitKey;
              recoverableOutcome = "wait_timeout";
              recoverableErrorMessage = `Timed out waiting for document text to disappear: '${formattedExpectedText}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`;
              logger.warn(recoverableErrorMessage);
              return;
            }

            previousTimedOutWait = null;
            return;
          }

          previousTimedOutWait = null;

          if (plannerPayload.action === "request_user_input") {
            if (!config.headed) {
              throw new Error("LLM got blocked: requested user input in headless mode.");
            }

            const inputKey =
              plannerPayload.inputKey
                ;

            const promptText =
              plannerPayload.inputPrompt
                ;

            if (!humanInputs.has(inputKey)) {
              logger.info(`requesting human input for key '${inputKey}'`);
              const enteredValue = await interactionProvider.requestInput(`${promptText}: `);
              throwIfInterrupted();
              if (!enteredValue) {
                throw new Error(`No value entered for '${inputKey}'.`);
              }
              humanInputs.set(inputKey, enteredValue);
              logger.info(`received human input for key '${inputKey}'`);
            }

            return;
          }

          if (plannerPayload.action === "request_user_interaction") {
            if (!config.headed) {
              throw new Error("LLM got blocked: requested user interaction in headless mode.");
            }

            // If we just acted on the UI, give the app a chance to transition
            // before escalating to the user.
            const sinceLastUiActionMs = Date.now() - lastUiActionAt;
            if (lastUiActionAt > 0 && sinceLastUiActionMs < 3500) {
              logger.info("deferring user interaction prompt until UI settles after recent action");
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            const interactionPrompt =
              plannerPayload.interactionPrompt;

            // Require the same interaction request twice (with same URL/prompt)
            // before prompting the human. This avoids transient false positives.
            const interactionKey = `${page.url()}::${interactionPrompt}`;
            if (!pendingInteractionRequest || pendingInteractionRequest.key !== interactionKey) {
              pendingInteractionRequest = { key: interactionKey, count: 1 };
              logger.info(
                `seen first interaction request for '${interactionPrompt}' on ${page.url()}; waiting to confirm`
              );
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            pendingInteractionRequest.count += 1;
            if (pendingInteractionRequest.count < 2) {
              logger.info(
                `re-seen interaction request for '${interactionPrompt}'; waiting one more cycle before prompting`
              );
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            logger.info(`prompting for human interaction: ${interactionPrompt}`);
            const interactionNote = await interactionProvider.requestInput(`${interactionPrompt}. Optional note: `);
            throwIfInterrupted();
            if (interactionNote) {
              const key = `interaction_note_${stepIndex}`;
              humanInputs.set(key, interactionNote);
            }

            pendingInteractionRequest = null;

            return;
          }

          if (plannerPayload.action === "request_screenshot") {
            logger.info(
              `planner requested the most recent screenshot${
                plannerPayload.screenshotPrompt ? `: ${clip(plannerPayload.screenshotPrompt, 140)}` : ""
              }`
            );

            // Capture immediately from the current viewport so transient popups
            // (menus, sheets) are preserved for the next planner turn.
            pendingScreenshotBuffer = await captureViewportScreenshot();

            return;
          }

          if (plannerPayload.action === "scroll") {
            if (isAlternatingScrollLoop(actionHistory, plannerPayload)) {
              throw new Error(
                `Alternating scroll loop detected in '${plannerPayload.containerId}'. Choose a non-scroll action or finish based on current evidence.`
              );
            }
            const container = observation.scrollContainers.find(
              (candidate) => candidate.id === plannerPayload.containerId
            );
            if (!container) {
              throw new Error(`Planner scroll container '${plannerPayload.containerId}' is not in the observation.`);
            }
            if (plannerPayload.direction === "down" && !container.canScrollDown) {
              throw new Error(`Planner scroll container '${container.id}' cannot scroll down.`);
            }
            if (plannerPayload.direction === "up" && !container.canScrollUp) {
              throw new Error(`Planner scroll container '${container.id}' cannot scroll up.`);
            }

            const scrollContainer = page
              .locator(`[data-agentic-turn="${turnToken}"][data-agentic-scroll-id="${container.id}"]`)
              .first();
            if ((await scrollContainer.count()) === 0) {
              throw new Error(`Planner scroll container '${container.id}' is no longer available.`);
            }

            const didScroll = await scrollContainer.evaluate((element, direction) => {
              const start = element.scrollTop;
              const amount = Math.max(200, Math.floor(element.clientHeight * 0.8));
              element.scrollBy({ top: direction === "down" ? amount : -amount, behavior: "instant" });
              return Math.abs(element.scrollTop - start) > 1;
            }, plannerPayload.direction);
            if (!didScroll) {
              throw new Error(`Planner scroll container '${container.id}' did not move.`);
            }

            logger.info(`scrolling ${plannerPayload.direction} in ${container.id}`);
            await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
            return;
          }

          if (
            plannerPayload.action !== "click" &&
            plannerPayload.action !== "fill" &&
            plannerPayload.action !== "select_option"
          ) {
            throw new Error(`Unsupported planner action: ${plannerPayload.action}`);
          }

          const matchedControl = resolveTargetControl(observation.controls, plannerPayload.target);
          const matchedControlId = matchedControl.id;
          actionTarget = {
            label: matchedControl.label,
            ...(matchedControl.ariaLabel ? { ariaLabel: matchedControl.ariaLabel } : {}),
            ...(matchedControl.text ? { text: matchedControl.text } : {}),
            ...(matchedControl.role ? { role: matchedControl.role } : {}),
            ...(matchedControl.type ? { type: matchedControl.type } : {}),
          };

          const target = page
            .locator(`[data-agentic-turn="${turnToken}"][data-agentic-id="${matchedControlId}"]`)
            .first();
          if ((await target.count()) === 0) {
            throw new Error(`Planner target not found: ${describeTarget(plannerPayload.target)}`);
          }

          if (plannerPayload.action === "click") {
            const isDisabled = await isTargetDisabled(target);
            if (isDisabled) {
              logger.warn(`target ${describeTarget(plannerPayload.target)} is disabled before click; replanning immediately`);
              throw new Error(`Disabled target before click: ${describeTarget(plannerPayload.target)}`);
            }

            logger.info(`clicking target ${describeTarget(plannerPayload.target)}`);
            await target.click({ timeout: 1500 });
            throwIfInterrupted();
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
            await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
            return;
          }

          if (plannerPayload.action === "fill") {
            const fillValue = resolveFillValue(plannerPayload.value, contextData, humanInputs, secretValues);
            logger.info(`filling target ${describeTarget(plannerPayload.target)}`);

            await target.fill(fillValue);
            throwIfInterrupted();
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
            await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
            return;
          }

          if (plannerPayload.action === "select_option") {
            if (matchedControl.tag !== "select") {
              throw new Error(`Planner select_option target is not a native select: ${describeTarget(plannerPayload.target)}`);
            }
            const option = matchedControl.options?.find((candidate) => candidate.value === plannerPayload.value);
            if (!option) {
              throw new Error(`Planner select_option value is not available: ${plannerPayload.value}`);
            }
            if (option.disabled) {
              throw new Error(`Planner select_option value is disabled: ${plannerPayload.value}`);
            }

            logger.info(`selecting '${option.label || option.value}' in ${describeTarget(plannerPayload.target)}`);
            await target.selectOption({ value: plannerPayload.value });
            throwIfInterrupted();
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
            await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
            return;
          }

          throw new Error(`Unsupported planner action: ${plannerPayload.action}`);
        },
        stepDebugContext
      );
    } catch (error) {
        const recoverableKind = classifyRecoverableActionError(error);
        if (!recoverableKind) {
          throw error;
        }

        recoverableOutcome = recoverableKind;
        recoverableErrorMessage = errorMessage(error);
        logger.warn(`recoverable action failure (${recoverableKind}): ${recoverableErrorMessage}`);
        await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
      }

      actionHistory.push({
        step: stepIndex,
        url: page.url(),
        action: plannerAction,
        ...(actionTarget ? { target: actionTarget } : {}),
        outcome: recoverableOutcome || "ok",
        runnerFeedback:
          recoverableOutcome === "disabled_target"
            ? "Click was blocked because the target is disabled. Resolve any prerequisite validation or required fields before trying again."
            : recoverableOutcome === "target_disappeared"
              ? "The target disappeared before the action could run, so the UI is transitioning. Inspect the fresh observation instead of repeating the action."
            : recoverableOutcome === "wait_timeout"
              ? "The requested document text did not disappear within the configured settle timeout. Inspect the current observation and choose a different action."
              : recoverableOutcome === "duplicate_wait"
                ? "The same wait condition already timed out without a state change. Choose a different action."
                  : recoverableOutcome === "invalid_selection"
                    ? "select_option is only valid for native select controls with an observed options list. For a custom combobox, click a visible role=option control."
                    : recoverableOutcome === "scroll_loop"
                      ? "Repeated alternating scrolling does not add evidence. Use completedWork and the current observation to take a non-scroll action or finish."
            : undefined,
        error: recoverableErrorMessage || undefined,
      });

      if (report.status !== "running") {
        break;
      }
    }

    throwIfInterrupted();

    if (report.status === "running") {
      report.status = "failed";
      report.finalUrl = page.url();
      report.error = `Max steps reached (${config.maxSteps}) before objective completion.`;
      logger.error(report.error);
    }
  } catch (error) {
    if (isInterruptError(error) || browserClosed) {
      report.status = "interrupted";
      report.finalUrl = currentPageUrl();
      report.error = browserClosed ? "Browser was closed." : error.message;
    } else {
      report.status = "failed";
      report.finalUrl = currentPageUrl();
      report.error = error instanceof Error ? error.message : String(error);
      logger.error(report.error);
      if (!browserClosed) {
        const failureScreenshot = path.join(screenshotsDir, "failure.png");
        await captureViewportScreenshot({ path: failureScreenshot });

        if (config.debug) {
          const failureHtmlPath = path.join(screenshotsDir, "failure.html");
          const html = await page.content();
          await writeFile(failureHtmlPath, html, "utf8");
        }
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();

    const configuredPricing = getConfiguredModelPricing(config);
    if (configuredPricing) {
      report.pricing = {
        provider: config.llm.provider,
        modelId: config.llm.modelId,
        ...(config.llm.region ? { region: config.llm.region } : {}),
        ...configuredPricing,
      };
      report.costEstimate = calculateCostEstimate(report.tokenUsage, configuredPricing);
    }

    const finalRunId = createRunId(startedAt, resolveRunOutcome(report.status), runLabel);
    const finalRunDir = path.join(config.outputDir, finalRunId);
    await rename(runDir, finalRunDir);
    runId = finalRunId;
    runDir = finalRunDir;
    report.runId = runId;
    report.artifactsDir = runDir;

    const reportPath = path.join(runDir, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const generatedReports = await generateReportArtifacts(reportPath, config.reports);
    const { summaryPath, summaryHtmlPath } = generatedReports;

    const latestManifestPath = path.join(config.outputDir, "latest.json");
    const latestManifest = {
      runId,
      status: report.status,
      finalUrl: report.finalUrl,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      artifactsDir: runDir,
      reportPath,
      summaryPath,
      summaryHtmlPath,
      provider: config.llm.provider,
      modelId: config.llm.modelId,
      ...(config.llm.region ? { region: config.llm.region } : {}),
      costEstimate: report.costEstimate,
    };
    await writeFile(latestManifestPath, `${JSON.stringify(latestManifest, null, 2)}\n`, "utf8");

    await browserSession.close();

    const statusPrefix = report.status === "passed"
      ? "PASS"
      : report.status === "interrupted"
        ? "INTERRUPTED"
        : "FAIL";

    if (report.status === "failed" && report.error) {
      process.stderr.write(`Failure reason: ${report.error}\n`);
    }

    process.stdout.write(`${statusPrefix}: ${runDir}\n`);
    logger.info(`finished run with status ${report.status}`);

    if (report.status !== "passed" && report.status !== "interrupted") {
      process.exitCode = 1;
    }
  }

  return report;
}

function createInterruptError(message) {
  const error = new Error(message);
  error.name = "InterruptError";
  return error;
}

function isInterruptError(error) {
  return error instanceof Error && error.name === "InterruptError";
}
