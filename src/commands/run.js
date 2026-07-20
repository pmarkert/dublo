import fs from "node:fs";
import path from "node:path";
import { runScenario } from "../scenario-runner.mjs";
import { loadScenarioConfig } from "../utils/loadScenarioConfig.js";
import { resolvePersonaProfilePath } from "./persona/shared.js";
import { resolveScenarioProfilePath } from "./scenario/shared.js";
import { logger } from "../utils/logger.js";

export async function runCommand(options) {
  const config = loadScenarioConfig(options);
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };

  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  const llmSelection = firstDefined(
    config.llmRef,
    config.workspaceLlmRef,
    inferSingleProfile(config.workspace, "llm", [".json"])
  );

  if (llmSelection) {
    const llmPath = resolveReference({
      value: llmSelection,
      workspace: config.workspace,
      folder: "llm",
      exts: [".json"],
      required: true,
      kind: "llm"
    });
    const llmFromFile = readJson(llmPath, "llm profile");
    config.llm = {
      ...config.llm,
      ...llmFromFile
    };
  }

  config.llm = normalizeLlmConfig(config.llm);

  const personaSelection = firstDefined(
    config.persona,
    config.workspacePersonaRef,
    inferSingleProfile(config.workspace, "personas", [".md", ".txt"])
  );

  if (personaSelection) {
    config.personaFile = resolvePersonaProfilePath(config.workspace, personaSelection);
    if (!config.personaFile) {
      throw new Error(
        `Could not resolve persona '${personaSelection}'. Provide a valid path, a profile name under ${path.join(config.workspace, "personas")}, or a built-in template name.`
      );
    }
  }

  const contextSelections = firstNonEmptyArray(config.contextRefs, config.workspaceContextRefs);
  config.contextFiles = contextSelections.map((value) =>
    resolveReference({
      value,
      workspace: config.workspace,
      folder: "context",
      exts: [".json", ".yaml", ".yml"],
      required: true,
      kind: "context"
    })
  );
  config.contextOperations = resolveContextOperations(config);

  if (config.scenario && config.adhocScenario) {
    throw new Error("Provide either a scenario reference (--scenario or positional) or --adhoc, not both.");
  }

  if (config.scenario && !config.scenarioFile) {
    const scenarioPath = resolveScenarioProfilePath(config.workspace, config.scenario);

    if (scenarioPath) {
      config.scenarioFile = scenarioPath;
      config.scenario = "";
    } else {
      throw new Error(
        `Could not resolve scenario '${config.scenario}'. Use an existing scenario file/profile or pass inline text with --adhoc.`
      );
    }
  }

  if (config.adhocScenario) {
    config.scenario = config.adhocScenario;
  }

  if (!config.baseUrl) {
    throw new Error("A base URL is required. Set baseUrl in <workspace>/defaults.json or DUBLO_BASE_URL.");
  }

  if (!config.scenario && !config.scenarioFile) {
    config.scenario = await readScenarioFromStdin();
    if (!config.scenario) {
      throw new Error("No scenario provided. Pass an existing scenario via positional/--scenario, use --adhoc for inline text, or pipe scenario text to stdin.");
    }
  }

  if (!config.llm?.provider) {
    throw new Error("LLM provider is required. Set it in your llm profile or DUBLO_LLM_PROVIDER.");
  }

  const supportedProviders = ["bedrock", "openai-compatible"];
  if (!supportedProviders.includes(config.llm.provider)) {
    throw new Error(`Unsupported llm.provider '${config.llm.provider}'. Supported providers: ${supportedProviders.join(", ")}.`);
  }

  if (!config.llm.modelId) {
    throw new Error("LLM model ID is required. Set it in your llm profile or DUBLO_LLM_MODEL_ID.");
  }

  if (config.llm.provider === "bedrock" && !config.llm.region) {
    throw new Error("LLM region is required for Bedrock. Set it in your llm profile or DUBLO_LLM_REGION.");
  }

  if (config.llm.provider === "openai-compatible" && !config.llm.baseUrl) {
    throw new Error("LLM baseUrl is required for openai-compatible. Set it in your llm profile or DUBLO_LLM_BASE_URL.");
  }

  logger.info("Starting dublo run");
  logger.info(`Target: ${config.baseUrl}`);

  try {
    const report = await runScenario(config, {
      shouldInterrupt: () => interrupted
    });

    if (report?.status === "interrupted") {
      process.stderr.write("Interrupted.\n");
      process.exitCode = 130;
      return;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }

  logger.info("Run complete");
}

function inferSingleProfile(workspace, folder, exts) {
  const profileDir = path.join(workspace, folder);

  let entries;
  try {
    entries = fs.readdirSync(profileDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() && exts.some((ext) => entry.name.toLowerCase().endsWith(ext.toLowerCase()))
    )
    .map((entry) => path.join(profileDir, entry.name));

  if (candidates.length === 1) {
    return candidates[0];
  }

  return "";
}

function resolveReference({ value, workspace, folder, exts, required, kind }) {
  if (!value) return "";

  const direct = path.resolve(process.cwd(), value);
  if (isFile(direct)) {
    return direct;
  }

  const base = path.join(workspace, folder);
  const candidates = [];
  candidates.push(path.join(base, value));
  for (const ext of exts) {
    candidates.push(path.join(base, `${value}${ext}`));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  if (required) {
    throw new Error(
      `Could not resolve ${kind} '${value}'. Provide a valid path or a profile name under ${path.join(workspace, folder)}.`
    );
  }

  return "";
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJson(filePath, label) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} at '${filePath}': ${detail}`);
  }
}

async function readScenarioFromStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let body = "";
  for await (const chunk of process.stdin) {
    body += String(chunk);
  }

  return body.trim();
}

function normalizeLlmConfig(value = {}) {
  const llm = value && typeof value === "object" ? value : {};
  return {
    ...llm,
    provider: firstDefined(llm.provider),
    region: firstDefined(llm.region),
    modelId: firstDefined(llm.modelId, llm["model-id"]),
    baseUrl: firstDefined(llm.baseUrl, llm["base-url"]),
    apiKey: firstDefined(llm.apiKey, llm["api-key"]),
    inputPrice: firstDefined(llm.inputPrice, llm["input-price"]),
    outputPrice: firstDefined(llm.outputPrice, llm["output-price"]),
    cacheReadPrice: firstDefined(llm.cacheReadPrice, llm["cache-read-price"]),
    cacheWritePrice: firstDefined(llm.cacheWritePrice, llm["cache-write-price"]),
    currency: firstDefined(llm.currency),
    tokenUnit: firstDefined(llm.tokenUnit, llm["token-unit"]),
    supportsConditionalToolSchemas: firstDefined(llm.supportsConditionalToolSchemas)
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstNonEmptyArray(...arrays) {
  for (const value of arrays) {
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  return [];
}

function resolveContextOperations(config) {
  if (Array.isArray(config.contextOperations) && config.contextOperations.length > 0) {
    return config.contextOperations.map((operation) => {
      if (operation.type !== "context") {
        return operation;
      }

      return {
        type: "context",
        value: resolveReference({
          value: operation.value,
          workspace: config.workspace,
          folder: "context",
          exts: [".json", ".yaml", ".yml"],
          required: true,
          kind: "context"
        })
      };
    });
  }

  const operations = [];
  for (const contextFile of config.contextFiles) {
    operations.push({ type: "context", value: contextFile });
  }
  for (const entry of Array.isArray(config.setEntries) ? config.setEntries : []) {
    operations.push({ type: "set", value: entry });
  }
  for (const entry of Array.isArray(config.jsonEntries) ? config.jsonEntries : []) {
    operations.push({ type: "json", value: entry });
  }

  return operations;
}
