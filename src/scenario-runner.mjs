import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import * as yaml from "js-yaml";
import { chromium } from "playwright";
import { generateReportArtifacts, rerenderReportArtifacts } from "./reporting/report-artifacts.mjs";

const FORBIDDEN_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_INLINE_JSON_LENGTH = 16 * 1024;

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

function resolveRunLabel(config, scenario) {
  if (config.scenarioFile) {
    const fileName = path.basename(String(config.scenarioFile));
    const profileName = path.basename(fileName, path.extname(fileName));
    return sanitizeSegment(profileName || "scenario");
  }

  return sanitizeSegment(String(scenario || "scenario").slice(0, 48));
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

function normalizeTokenUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  return {
    inputTokens: toNumberOrZero(usage.inputTokens ?? usage.inputTokenCount),
    outputTokens: toNumberOrZero(usage.outputTokens ?? usage.outputTokenCount),
    totalTokens: toNumberOrZero(usage.totalTokens ?? usage.totalTokenCount),
    cacheReadInputTokens: toNumberOrZero(usage.cacheReadInputTokens ?? usage.cacheReadInputTokenCount),
    cacheWriteInputTokens: toNumberOrZero(usage.cacheWriteInputTokens ?? usage.cacheWriteInputTokenCount),
  };
}

function normalizeOpenAITokenUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  return {
    inputTokens: toNumberOrZero(usage.prompt_tokens ?? usage.inputTokens),
    outputTokens: toNumberOrZero(usage.completion_tokens ?? usage.outputTokens),
    totalTokens: toNumberOrZero(usage.total_tokens ?? usage.totalTokens),
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
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

function classifyRecoverableActionError(error) {
  const message = errorMessage(error).toLowerCase();

  if (
    message.includes("element is not enabled") ||
    message.includes("<button disabled") ||
    message.includes("disabled target before click")
  ) {
    return "disabled_target";
  }

  return null;
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

function extractJsonFromText(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Planner returned empty text.");
  }

  if (trimmed.startsWith("```")) {
    const withoutFenceStart = trimmed.replace(/^```(?:json)?\s*/i, "");
    const withoutFence = withoutFenceStart.replace(/\s*```$/, "");
    return withoutFence.trim();
  }

  return trimmed;
}

function extractFirstJsonObjectFromText(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    throw new Error("Planner returned empty text.");
  }

  // Prefer fenced JSON blocks when present.
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    const fencedCandidate = fencedMatch[1].trim();
    try {
      return JSON.parse(fencedCandidate);
    } catch {
      // Fall through to brace scanning if fenced content is not valid JSON.
    }
  }

  // Extract the first balanced top-level JSON object from mixed prose text.
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = trimmed.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }

  throw new Error("Planner text did not contain a valid JSON object.");
}

function plannerBedrockToolSpec(llmConfig) {
  return {
    tools: [
      {
        toolSpec: {
          name: "planner_action",
          description: "Return the next UI automation action as structured JSON input. Click and fill actions require a visible targetId; fill also requires a value.",
          inputSchema: {
            json: plannerActionSchema({
              includeConditionalRequirements: supportsConditionalToolSchemas(llmConfig),
            }),
          },
        },
      },
    ],
  };
}

function plannerOpenAIToolSpec() {
  return {
    tools: [
      {
        type: "function",
        function: {
          name: "planner_action",
          description: "Return the next UI automation action as structured JSON input. Click and fill actions require a visible targetId; fill also requires a value.",
          parameters: plannerActionSchema(),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "planner_action" } },
  };
}

function plannerActionSchema({ includeConditionalRequirements = true } = {}) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "click",
          "fill",
          "wait",
          "request_user_input",
          "request_user_interaction",
          "request_screenshot",
          "finish",
        ],
      },
      targetId: {
        type: "string",
        description: "Required for click and fill actions. Must match a visible control id from the observation.",
      },
      value: {
        type: "string",
        description: "Required for fill actions. The value to enter into the target control.",
      },
      inputKey: { type: "string" },
      inputPrompt: { type: "string" },
      interactionPrompt: { type: "string" },
      screenshotPrompt: { type: "string" },
      reason: {
        type: "string",
        minLength: 1,
        description: "Required for every action. Briefly explain why this is the best next step.",
      },
    },
    required: ["action", "reason"],
  };

  if (!includeConditionalRequirements) {
    return schema;
  }

  return {
    ...schema,
    allOf: [
      {
        if: { properties: { action: { const: "click" } }, required: ["action"] },
        then: { required: ["targetId"] },
      },
      {
        if: { properties: { action: { const: "fill" } }, required: ["action"] },
        then: { required: ["targetId", "value"] },
      },
      {
        if: { properties: { action: { const: "request_user_input" } }, required: ["action"] },
        then: { required: ["inputKey", "inputPrompt"] },
      },
      {
        if: { properties: { action: { const: "request_user_interaction" } }, required: ["action"] },
        then: { required: ["interactionPrompt"] },
      },
      {
        if: { properties: { action: { const: "request_screenshot" } }, required: ["action"] },
        then: { required: ["screenshotPrompt"] },
      },
    ],
  };
}

function supportsConditionalToolSchemas(llmConfig) {
  if (llmConfig?.supportsConditionalToolSchemas === false) {
    return false;
  }

  return true;
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

async function readHumanInputFromTerminal(promptText) {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(promptText);
    return value.trim();
  } finally {
    rl.close();
  }
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

async function loadContextFromOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return {};
  }

  const merged = {};
  for (const operation of operations) {
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
    }
  }

  return merged;
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

function resolveFillValue(rawValue, contextData, humanInputs) {
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

  return rawValue;
}

async function collectObservation(page, observationConfig, turnToken) {
  return page.evaluate(({ config, turnToken: activeTurnToken }) => {
    const cfg = config && typeof config === "object" ? config : {};

    const controlsSelector =
      typeof cfg.controlsSelector === "string" && cfg.controlsSelector.trim().length > 0
        ? cfg.controlsSelector
        : "button, a, input, textarea, select, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']";
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
    const modalBlocksBackground =
      Boolean(activeModal) &&
      visibleOutsideModalControls.length > 0 &&
      !visibleOutsideModalControls.some((el) => isLayerClickable(el));
    const scopeRoot = modalBlocksBackground && activeModal ? activeModal : globalThis.document;

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

    for (const selector of priorityControlSelectors) {
      const nodes = queryAllWithin(scopeRoot, selector);

      for (const el of nodes) {
        if (seenElements.has(el)) continue;
        if (!isVisible(el)) continue;
        if (!isLayerClickable(el)) continue;
        if (shouldIgnoreControl(el)) continue;
        seenElements.add(el);
        selectedElements.push({ el, priority: true });
      }
    }

    let generalNodes = [];
    generalNodes = queryAllWithin(scopeRoot, controlsSelector);

    for (const el of generalNodes) {
      if (selectedElements.length >= maxControls) break;
      if (seenElements.has(el)) continue;
      if (!isVisible(el)) continue;
      if (!isLayerClickable(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: false });
    }

    for (const el of queryAllWithin(globalThis.document, "[data-agentic-id], [data-agentic-turn]")) {
      el.removeAttribute("data-agentic-id");
      el.removeAttribute("data-agentic-turn");
    }

    let sequence = 0;
    const visibleControls = selectedElements.map(({ el, priority }) => {
      sequence += 1;
      const agenticId = `a${sequence}`;
      el.setAttribute("data-agentic-id", agenticId);
      el.setAttribute("data-agentic-turn", activeTurnToken);

      const text = normalizeText(el.textContent || "");
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const id = el.getAttribute("id") || "";
      const label = id
        ? (globalThis.document.querySelector(`label[for='${globalThis.CSS.escape(id)}']`)?.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
        : "";
      const disabled =
        ("disabled" in el && Boolean(el.disabled)) || el.getAttribute("aria-disabled") === "true" || false;

      let value = "";
      let hasValue = false;
      let checked = false;

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

      return {
        id: agenticId,
        tag,
        role,
        type,
        priority,
        text,
        ariaLabel,
        label,
        placeholder,
        ...(value ? { value } : {}),
        hasValue,
        checked,
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
      controls: visibleControls,
    };
  }, { config: observationConfig, turnToken });
}

function buildPlannerMessages({
  testPrompt,
  personaText,
  workspacePromptText,
  contextData,
  observation,
  actionHistory,
  humanInputs,
  screenshotRequested,
}) {
  const compactControls = observation.controls.map((control) => ({
    id: control.id,
    tag: control.tag,
    role: control.role,
    type: control.type,
    text: clip(control.text),
    label: clip(control.label),
    ariaLabel: clip(control.ariaLabel),
    placeholder: clip(control.placeholder),
    ...(control.value ? { value: clip(control.value) } : {}),
    hasValue: control.hasValue,
    checked: control.checked,
    ...(control.disabled ? { disabled: true } : {}),
  }));

  const history = actionHistory.slice(-10);
  const knownHumanInputs = Object.fromEntries(humanInputs.entries());

  const staticContext = {
    contextData,
    planningRules: [
      "Use visible controls only.",
      "Always provide a non-empty reason for the chosen action.",
      "If observation.modal.blocksBackground is true, only interact with controls listed from the blocking modal context.",
      "If observation.modal.open is true but observation.modal.blocksBackground is false, you may still use background controls when needed.",
      "Do not invent element IDs.",
      "For click and fill actions, always provide a targetId that matches a visible control.",
      "Never emit click or fill without targetId.",
      "For fill actions, also provide a value.",
      "Do not use the 'Continue with Google' login because the Google page will not load properly in this browser.",
      "Do not fill the same field with a different value unless visible validation or error evidence shows correction is needed.",
      "Use observation.documentText as the main source of visible page text when deciding whether login or onboarding is still loading or has finished.",
      "Do not return finish while the UI appears to be loading or transitioning.",
      "Before finish, verify visible evidence for the success criteria in the test prompt.",
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
      url: observation.url,
      title: observation.title,
      modal: observation.modal,
      headings: observation.headings,
      alerts: observation.alerts,
      documentText: clip(observation.documentText, 1600),
      controls: compactControls,
    },
    screenshotRequested,
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

async function requestPlannerAction({ config, bedrockClient, messages, screenshotBuffer }) {
  let plannerResult;

  if (config.llm.provider === "openai-compatible") {
    plannerResult = await requestPlannerActionOpenAI({
      baseUrl: config.llm.baseUrl,
      modelId: config.llm.modelId,
      apiKey: config.llm.apiKey,
      messages,
      screenshotBuffer,
    });
  } else {
    plannerResult = await requestPlannerActionBedrock({
      client: bedrockClient,
      modelId: config.llm.modelId,
      llmConfig: config.llm,
      messages,
      screenshotBuffer,
    });
  }

  const parsed = plannerResult?.parsed;
  const tokenUsage = plannerResult?.tokenUsage;

  if (!parsed || typeof parsed !== "object" || typeof parsed.action !== "string") {
    throw new Error(`Planner response missing action: ${JSON.stringify(parsed)}`);
  }

  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    throw new Error(`Planner response missing reason: ${JSON.stringify(parsed)}`);
  }

  return {
    action: parsed.action,
    targetId: parsed.targetId,
    value: parsed.value,
    inputKey: parsed.inputKey,
    inputPrompt: parsed.inputPrompt,
    interactionPrompt: parsed.interactionPrompt,
    screenshotPrompt: parsed.screenshotPrompt,
    reason: parsed.reason.trim(),
    tokenUsage,
  };
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

async function waitForUiSettle(page, settleArg = 700) {
  const minStableMs = Number.isFinite(settleArg) ? Math.max(120, Number(settleArg)) : 700;
  const maxWaitMs = Math.max(2200, minStableMs * 4);
  const pollMs = 120;

  const startedAt = Date.now();
  let stableSince = Date.now();
  let previousSignature = "";

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 1200 });
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

export async function runScenario(config, options = {}) {
  const startedAt = new Date();
  const shouldInterrupt = typeof options.shouldInterrupt === "function" ? options.shouldInterrupt : () => false;

  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) {
    throw new Error("--max-steps must be a positive number");
  }

  const throwIfInterrupted = () => {
    if (shouldInterrupt()) {
      throw createInterruptError();
    }
  };

  const contextData = await loadContextFromOperations(config.contextOperations);
  const personaText = await loadPersonaText(config.personaFile);
  const workspacePromptText = await loadWorkspacePromptText(config.workspacePromptFile);
  const scenario = await resolveScenarioText(config);
  const observationConfig = await loadObservationConfig(config.observationConfigFile);
  const screenshots = normalizeScreenshotMode(config.screenshots);

  const runLabel = resolveRunLabel(config, scenario);
  const runId = `${startedAt.toISOString().replace(/[.:]/g, "-")}-${runLabel}`;
  const runDir = path.join(config.outputDir, runId);
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
      contextOperations: config.contextOperations,
      workspacePromptFile: config.workspacePromptFile,
      personaFile: config.personaFile,
      scenarioFile: config.scenarioFile,
      observationConfigFile: config.observationConfigFile,
      screenshots,
      reports: Array.isArray(config.reports) ? config.reports : [],
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

  const bedrockClient =
    config.llm.provider === "bedrock" ? new BedrockRuntimeClient({ region: config.llm.region }) : null;

  const logger = createRunnerLogger(config.headed);
  const debugLogger = createDebugLogger(config.debug);
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

  if (config.llm.provider === "openai-compatible") {
    logger.info(`running OpenAI-compatible preflight against model ${config.llm.modelId}`);
    if (shouldInterrupt()) {
      return {
        status: "interrupted",
        error: "Interrupted by Ctrl-C."
      };
    }
    await runOpenAIPreflight({ baseUrl: config.llm.baseUrl, modelId: config.llm.modelId, apiKey: config.llm.apiKey });
    logger.info("OpenAI-compatible preflight succeeded");
  } else {
    logger.info(`running Bedrock preflight against model ${config.llm.modelId}`);
    if (shouldInterrupt()) {
      return {
        status: "interrupted",
        error: "Interrupted by Ctrl-C."
      };
    }
    await runBedrockPreflight({ client: bedrockClient, modelId: config.llm.modelId, llmConfig: config.llm });
    logger.info("Bedrock preflight succeeded");
  }

  if (shouldInterrupt()) {
    return {
      status: "interrupted",
      error: "Interrupted by Ctrl-C."
    };
  }

  const browser = await chromium.launch({ headless: !config.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  let stepIndex = 0;
  const actionHistory = [];
  const humanInputs = new Map();
  let observationTurn = 0;
  let lastUiActionAt = 0;
  let pendingInteractionRequest = null;
  let pendingScreenshotBuffer = null;

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

  async function captureStep(name, plannerAction, execute, stepDebugContext = undefined) {
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
      if (screenshots !== "none") {
        await page.waitForTimeout(120);
        await captureArtifactScreenshot({ path: screenshotPath });
        stepScreenshotRelativePath = path.relative(runDir, screenshotPath);
      }

      if (config.debug) {
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
        outcome: stepError ? "error" : "ok",
        error: stepError || undefined,
      });
    }
  }

  try {
    throwIfInterrupted();

    await captureStep("open_start_page", { action: "navigate", reason: "scenario start" }, async () => {
      throwIfInterrupted();
      logger.info(`navigating to ${config.baseUrl}`);
      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
      await waitForUiSettle(page, 900);
    });

    for (let i = 0; i < config.maxSteps; i += 1) {
      throwIfInterrupted();
      await waitForUiSettle(page, 550);
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
        observation,
        actionHistory,
        humanInputs,
        screenshotRequested: Boolean(screenshotBufferForThisTurn),
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
        config,
        bedrockClient,
        messages,
        screenshotBuffer: screenshotBufferForThisTurn,
      });

      throwIfInterrupted();

      const { tokenUsage: plannerTokenUsage, ...plannerAction } = plannerResult;

      if (plannerTokenUsage) {
        addTokenUsageTotals(report.tokenUsage, plannerTokenUsage);
      }

      logger.info(
        `planner action ${i + 1}: ${plannerAction.action}${plannerAction.targetId ? ` target=${plannerAction.targetId}` : ""}${plannerAction.reason ? ` reason=${clip(plannerAction.reason, 140)}` : ""}`
      );

      const actionName = `${plannerAction.action}_${plannerAction.targetId ?? "none"}`;

      let recoverableOutcome = null;
      let recoverableErrorMessage = "";
      const stepDebugContext = config.debug
        ? {
            observation,
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
          if (plannerAction.action === "finish") {
            logger.info(`finish accepted at ${page.url()}`);
            report.status = "passed";
            report.finalUrl = page.url();
            return;
          }

          if (plannerAction.action === "wait") {
            logger.info("planner requested wait; allowing UI to settle");
            await page.waitForTimeout(1200);
            return;
          }

          if (plannerAction.action === "request_user_input") {
            if (!config.headed) {
              throw new Error("LLM got blocked: requested user input in headless mode.");
            }

            const inputKey =
              typeof plannerAction.inputKey === "string" && plannerAction.inputKey.trim().length > 0
                ? plannerAction.inputKey.trim()
                : "value";

            const promptText =
              typeof plannerAction.inputPrompt === "string" && plannerAction.inputPrompt.trim().length > 0
                ? plannerAction.inputPrompt.trim()
                : `Enter value for '${inputKey}'`;

            if (!humanInputs.has(inputKey)) {
              logger.info(`requesting human input for key '${inputKey}'`);
              const enteredValue = await readHumanInputFromTerminal(`${promptText}: `);
              throwIfInterrupted();
              if (!enteredValue) {
                throw new Error(`No value entered for '${inputKey}'.`);
              }
              humanInputs.set(inputKey, enteredValue);
              logger.info(`received human input for key '${inputKey}'`);
            }

            return;
          }

          if (plannerAction.action === "request_user_interaction") {
            if (!config.headed) {
              throw new Error("LLM got blocked: requested user interaction in headless mode.");
            }

            // If we just acted on the UI, give the app a chance to transition
            // before escalating to the user.
            const sinceLastUiActionMs = Date.now() - lastUiActionAt;
            if (lastUiActionAt > 0 && sinceLastUiActionMs < 3500) {
              logger.info("deferring user interaction prompt until UI settles after recent action");
              await waitForUiSettle(page, 1500);
              return;
            }

            const interactionPrompt =
              typeof plannerAction.interactionPrompt === "string" && plannerAction.interactionPrompt.trim().length > 0
                ? plannerAction.interactionPrompt.trim()
                : "Please perform the requested interaction in the browser and press Enter when done";

            // Require the same interaction request twice (with same URL/prompt)
            // before prompting the human. This avoids transient false positives.
            const interactionKey = `${page.url()}::${interactionPrompt}`;
            if (!pendingInteractionRequest || pendingInteractionRequest.key !== interactionKey) {
              pendingInteractionRequest = { key: interactionKey, count: 1 };
              logger.info(
                `seen first interaction request for '${interactionPrompt}' on ${page.url()}; waiting to confirm`
              );
              await waitForUiSettle(page, 1200);
              return;
            }

            pendingInteractionRequest.count += 1;
            if (pendingInteractionRequest.count < 2) {
              logger.info(
                `re-seen interaction request for '${interactionPrompt}'; waiting one more cycle before prompting`
              );
              await waitForUiSettle(page, 1200);
              return;
            }

            logger.info(`prompting for human interaction: ${interactionPrompt}`);
            const interactionNote = await readHumanInputFromTerminal(`${interactionPrompt}. Optional note: `);
            throwIfInterrupted();
            if (interactionNote) {
              const key = `interaction_note_${stepIndex}`;
              humanInputs.set(key, interactionNote);
            }

            pendingInteractionRequest = null;

            return;
          }

          if (plannerAction.action === "request_screenshot") {
            logger.info(
              `planner requested the most recent screenshot${
                typeof plannerAction.screenshotPrompt === "string" && plannerAction.screenshotPrompt.trim().length > 0
                  ? `: ${clip(plannerAction.screenshotPrompt, 140)}`
                  : ""
              }`
            );

            // Capture immediately from the current viewport so transient popups
            // (menus, sheets) are preserved for the next planner turn.
            pendingScreenshotBuffer = await captureViewportScreenshot();

            return;
          }

          if (!plannerAction.targetId) {
            throw new Error(`Planner action ${plannerAction.action} missing targetId.`);
          }

          const target = page
            .locator(`[data-agentic-turn="${turnToken}"][data-agentic-id="${plannerAction.targetId}"]`)
            .first();
          if ((await target.count()) === 0) {
            throw new Error(`Planner target not found: ${plannerAction.targetId}`);
          }

          if (plannerAction.action === "click") {
            const isDisabled = await isTargetDisabled(target);
            if (isDisabled) {
              logger.warn(`target ${plannerAction.targetId} is disabled before click; replanning immediately`);
              throw new Error(`Disabled target before click: ${plannerAction.targetId}`);
            }

            logger.info(`clicking target ${plannerAction.targetId}`);
            await target.click({ timeout: 1500 });
            throwIfInterrupted();
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
            await waitForUiSettle(page, 900);
            return;
          }

          if (plannerAction.action === "fill") {
            const fillValue = resolveFillValue(plannerAction.value, contextData, humanInputs);
            logger.info(`filling target ${plannerAction.targetId}`);

            await target.fill(fillValue);
            throwIfInterrupted();
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
            await waitForUiSettle(page, 450);
            return;
          }

          throw new Error(`Unsupported planner action: ${plannerAction.action}`);
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
        await waitForUiSettle(page, 700);
      }

      actionHistory.push({
        step: stepIndex,
        url: page.url(),
        action: plannerAction,
        outcome: recoverableOutcome || "ok",
        runnerFeedback:
          recoverableOutcome === "disabled_target"
            ? "Click was blocked because the target is disabled. Resolve any prerequisite validation or required fields before trying again."
            : undefined,
        error: recoverableErrorMessage || undefined,
      });

      if (report.status === "passed") {
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
    if (isInterruptError(error)) {
      report.status = "interrupted";
      report.finalUrl = page.url();
      report.error = "Interrupted by Ctrl-C.";
    } else {
      report.status = "failed";
      report.finalUrl = page.url();
      report.error = error instanceof Error ? error.message : String(error);
      logger.error(report.error);
      const failureScreenshot = path.join(screenshotsDir, "failure.png");
      await captureViewportScreenshot({ path: failureScreenshot });

      if (config.debug) {
        const failureHtmlPath = path.join(screenshotsDir, "failure.html");
        const html = await page.content();
        await writeFile(failureHtmlPath, html, "utf8");
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

    await context.close();
    await browser.close();

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

function createInterruptError() {
  const error = new Error("Interrupted by Ctrl-C.");
  error.name = "InterruptError";
  return error;
}

function isInterruptError(error) {
  return error instanceof Error && error.name === "InterruptError";
}
