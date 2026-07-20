import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { DEFAULT_REPORT_GENERATORS, listReportGenerators } from "../reporting/report-artifacts.mjs";

dotenv.config();

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;

  const normalized = value.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received '${value}'.`);
  }

  return parsed;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function resolvePathOrEmpty(value) {
  if (!value) return "";
  return path.resolve(process.cwd(), value);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeOptionArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
}

function normalizeReportGenerators(value) {
  const available = new Set(listReportGenerators().map((entry) => entry.id));
  if (value === undefined || value === null) {
    return [...DEFAULT_REPORT_GENERATORS];
  }

  if (typeof value === "string" && value.trim().toLowerCase() === "none") {
    return [];
  }

  const normalized = normalizeStringArray(value).map((entry) => entry.toLowerCase());

  return normalized.filter((entry) => available.has(entry));
}

function normalizeContextOperations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowedTypes = new Set(["context", "set", "json", "secret"]);
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const type = String(entry.type || "").trim().toLowerCase();
      const rawValue = entry.value;
      const normalizedValue = typeof rawValue === "string" ? rawValue : String(rawValue || "");
      if (!allowedTypes.has(type) || !normalizedValue) {
        return null;
      }

      return {
        type,
        value: normalizedValue
      };
    })
    .filter(Boolean);
}

function resolvePathFromWorkspaceOrCwd(value, workspace) {
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.resolve(workspace, value);
}

export function loadScenarioConfig(overrides = {}) {
  const overrideContextRefs = normalizeStringArray(overrides.context);
  const environmentContextRefs = normalizeStringArray(process.env.DUBLO_CONTEXT);
  const overrideSetEntries = normalizeOptionArray(overrides.set);
  const overrideJsonEntries = normalizeOptionArray(overrides.json);
  const overrideContextOperations = normalizeContextOperations(overrides.contextOperations);
  const workspaceInput = firstDefined(
    overrides.workspace,
    process.env.DUBLO_WORKSPACE,
    "./.dublo"
  );
  const workspacePath = path.resolve(process.cwd(), workspaceInput);
  const workspaceConfigPath = path.join(workspacePath, "defaults.json");
  const workspacePromptPath = path.join(workspacePath, "prompt.md");

  let workspaceConfig = {};
  if (fs.existsSync(workspaceConfigPath)) {
    const raw = fs.readFileSync(workspaceConfigPath, "utf8");
    try {
      workspaceConfig = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in workspace defaults '${workspaceConfigPath}': ${detail}`);
    }
  }

  const workspaceRuntimeConfig = cleanUndefined({
    baseUrl: workspaceConfig.baseUrl,
    maxSteps: parseNumber(workspaceConfig.maxSteps, undefined),
    settleDelayMs: parsePositiveInteger(workspaceConfig.settleDelayMs, undefined),
    settleTimeoutMs: parsePositiveInteger(workspaceConfig.settleTimeoutMs, undefined),
    headless: parseBoolean(workspaceConfig.headless, undefined),
    observationConfigFile: workspaceConfig.observationConfigFile,
    screenshots: workspaceConfig.screenshots,
    reports: normalizeReportGenerators(workspaceConfig.reports),
    debug: parseBoolean(workspaceConfig.debug, undefined),
    outputDir: workspaceConfig.outputDir,
    workspaceLlmRef: firstDefined(workspaceConfig.llm),
    workspacePersonaRef: firstDefined(workspaceConfig.persona),
    workspaceContextRefs: normalizeStringArray(workspaceConfig.context)
  });

  const envConfig = {
    baseUrl: firstDefined(process.env.DUBLO_BASE_URL),
    maxSteps: parseNumber(firstDefined(process.env.DUBLO_MAX_STEPS), undefined),
    settleDelayMs: parsePositiveInteger(firstDefined(process.env.DUBLO_SETTLE_DELAY_MS), undefined),
    settleTimeoutMs: parsePositiveInteger(firstDefined(process.env.DUBLO_SETTLE_TIMEOUT_MS), undefined),
    headless: parseBoolean(firstDefined(process.env.DUBLO_HEADLESS), undefined),
    personaFile: firstDefined(process.env.DUBLO_PERSONA_FILE),
    scenarioFile: firstDefined(process.env.DUBLO_SCENARIO_FILE),
    adhocScenario: firstDefined(process.env.DUBLO_ADHOC_SCENARIO),
    observationConfigFile: firstDefined(process.env.DUBLO_OBSERVATION_CONFIG_FILE),
    screenshots: firstDefined(process.env.DUBLO_SCREENSHOTS),
    reports: normalizeReportGenerators(process.env.DUBLO_REPORTS),
    debug: parseBoolean(firstDefined(process.env.DUBLO_DEBUG), undefined),
    outputDir: firstDefined(process.env.DUBLO_OUTPUT_DIR),
    llmRef: firstDefined(process.env.DUBLO_LLM),
    persona: firstDefined(process.env.DUBLO_PERSONA),
    scenario: firstDefined(process.env.DUBLO_SCENARIO),
    contextRefs: environmentContextRefs,
    environmentContextRefs,
    llm: cleanUndefined({
      provider: firstDefined(process.env.DUBLO_LLM_PROVIDER),
      region: firstDefined(process.env.DUBLO_LLM_REGION, process.env.AWS_REGION),
      modelId: firstDefined(process.env.DUBLO_LLM_MODEL_ID, process.env.BEDROCK_MODEL_ID),
      baseUrl: firstDefined(process.env.DUBLO_LLM_BASE_URL),
      apiKey: firstDefined(process.env.DUBLO_LLM_API_KEY),
      inputPrice: parseNumber(firstDefined(process.env.DUBLO_LLM_INPUT_PRICE), undefined),
      outputPrice: parseNumber(firstDefined(process.env.DUBLO_LLM_OUTPUT_PRICE), undefined),
      cacheReadPrice: parseNumber(firstDefined(process.env.DUBLO_LLM_CACHE_READ_PRICE), undefined),
      cacheWritePrice: parseNumber(firstDefined(process.env.DUBLO_LLM_CACHE_WRITE_PRICE), undefined),
      currency: firstDefined(process.env.DUBLO_LLM_CURRENCY),
      tokenUnit: parseNumber(firstDefined(process.env.DUBLO_LLM_TOKEN_UNIT), undefined)
    })
  };

  const merged = {
    baseUrl: "http://localhost:8080",
    maxSteps: 40,
    settleDelayMs: 500,
    settleTimeoutMs: 3000,
    headless: false,
    personaFile: "",
    scenario: "",
    scenarioFile: "",
    adhocScenario: "",
    observationConfigFile: "",
    screenshots: "none",
    reports: [...DEFAULT_REPORT_GENERATORS],
    debug: false,
    outputDir: "./reports",
    llmRef: "",
    workspaceLlmRef: "",
    workspacePersonaRef: "",
    contextRefs: [],
    cliContextRefs: [],
    environmentContextRefs: [],
    workspaceContextRefs: [],
    contextOperations: [],
    setEntries: [],
    jsonEntries: [],
    persona: "",
    ...cleanUndefined(envConfig),
    ...workspaceRuntimeConfig,
    ...cleanUndefined({
      workspace: overrides.workspace,
      llmRef: overrides.llm,
      settleDelayMs: parsePositiveInteger(overrides.settleDelayMs, undefined),
      settleTimeoutMs: parsePositiveInteger(overrides.settleTimeoutMs, undefined),
      headless: overrides.headless ? true : undefined,
      debug: overrides.debug ? true : undefined,
      persona: overrides.persona,
      scenario: overrides.scenario,
      adhocScenario: overrides.adhocScenario,
      ...(overrideContextRefs.length > 0
        ? { contextRefs: overrideContextRefs, cliContextRefs: overrideContextRefs }
        : {}),
      ...(overrideSetEntries.length > 0 ? { setEntries: overrideSetEntries } : {}),
      ...(overrideJsonEntries.length > 0 ? { jsonEntries: overrideJsonEntries } : {}),
      ...(overrideContextOperations.length > 0 ? { contextOperations: overrideContextOperations } : {})
    }),
    llm: {
      provider: "bedrock",
      region: firstDefined(process.env.AWS_REGION, "us-east-1"),
      modelId: "amazon.nova-pro-v1:0",
      baseUrl: undefined,
      apiKey: undefined,
      inputPrice: undefined,
      outputPrice: undefined,
      cacheReadPrice: undefined,
      cacheWritePrice: undefined,
      currency: "USD",
      tokenUnit: 1000000,
      ...cleanUndefined(envConfig.llm || {})
    }
  };

  return {
    ...merged,
    screenshots: String(merged.screenshots || "none").toLowerCase(),
    reports: normalizeReportGenerators(merged.reports),
    headed: !Boolean(merged.headless),
    personaFile: resolvePathOrEmpty(merged.personaFile),
    scenarioFile: resolvePathOrEmpty(merged.scenarioFile),
    adhocScenario: String(merged.adhocScenario || ""),
    observationConfigFile: resolvePathFromWorkspaceOrCwd(merged.observationConfigFile, workspacePath),
    workspacePromptFile: fs.existsSync(workspacePromptPath) ? workspacePromptPath : "",
    workspace: workspacePath,
    outputDir: resolvePathFromWorkspaceOrCwd(merged.outputDir, workspacePath),
    llm: {
      ...merged.llm,
      provider: String(merged.llm?.provider || "bedrock").toLowerCase()
    }
  };
}

function cleanUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== "")
  );
}

