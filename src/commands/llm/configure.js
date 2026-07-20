import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const BEDROCK_MODEL_CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../resources/bedrock-models");
const RECOMMENDED_BEDROCK_MODELS_BY_REGION = loadRecommendedBedrockModelsByRegion(BEDROCK_MODEL_CONFIG_DIR);

const DEFAULT_LLM_PROFILE = {
  provider: "bedrock",
  region: firstDefined(process.env.AWS_REGION, "us-east-1"),
  modelId: "amazon.nova-pro-v1:0"
};

export async function configureLlmCommand(options = {}) {
  const workspaceInput = firstDefined(options.workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  const workspacePath = path.resolve(process.cwd(), workspaceInput);
  const llmDir = path.join(workspacePath, "llm");
  const workspaceConfigPath = path.join(workspacePath, "defaults.json");
  const workspaceConfig = await readExistingJsonObject(workspaceConfigPath);

  await mkdir(llmDir, { recursive: true });

  const profileName = sanitizeProfileName(firstDefined(options.profile, options.name, workspaceConfig.llm, "default"));
  const llmProfilePath = path.join(llmDir, `${profileName}.json`);
  const existingProfile = await readExistingJsonObject(llmProfilePath);

  const seed = {
    ...DEFAULT_LLM_PROFILE,
    ...existingProfile,
    provider: "bedrock"
  };

  if (options.yes) {
    const nonInteractiveProfile = buildNonInteractiveProfile(seed, options);
    await writeJsonFile(llmProfilePath, nonInteractiveProfile);
    const setDefault = options.setDefault === true;
    if (setDefault) {
      await updateWorkspaceLlmDefault(workspaceConfigPath, profileName);
    }

    process.stdout.write(`Wrote ${llmProfilePath}\n`);
    if (setDefault) {
      process.stdout.write(`Updated ${workspaceConfigPath} with llm='${profileName}'\n`);
    }
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(`\nDublo LLM configuration\n`);
    process.stdout.write(`Workspace: ${workspacePath}\n`);
    process.stdout.write(`Profile: ${profileName}\n`);
    process.stdout.write(`File: ${llmProfilePath}\n\n`);

    const region = await askBedrockRegionChoice(rl, String(seed.region || DEFAULT_LLM_PROFILE.region));
    const modelSelection = await askModelSelection(rl, region, String(seed.modelId || DEFAULT_LLM_PROFILE.modelId));
    const inferenceProfileOptions = getModelInferenceProfileOptions(region, modelSelection.modelId);
    const inferenceProfile = await askInferenceProfileChoice(
      rl,
      modelSelection.modelId,
      inferInferenceProfileScope(firstDefined(options.inferenceProfile, seed.inferenceProfile)),
      inferenceProfileOptions
    );
    const modelId = applyInferenceProfileScope(modelSelection.modelId, inferenceProfile, inferenceProfileOptions);
    const serviceTierOptions = getModelServiceTierOptions(region, modelId);
    const serviceTier = await askServiceTierChoice(
      rl,
      modelId,
      firstDefined(options.serviceTier, seed.serviceTier),
      serviceTierOptions
    );
    const modelRequestDefaults = modelSelection.modelRequestDefaults;
    const modelPricingDefaults = getModelPricingDefaults(region, modelId, {
      serviceTier,
      inferenceProfile
    });
    const hasModelPricingData = modelHasPricingData(region, modelId);
    const supportsConditionalToolSchemas = getModelSupportsConditionalToolSchemas(region, modelId);

    const runPreflight = await askBoolean(rl, "Run Bedrock preflight check now", true);
    if (runPreflight) {
      await runBedrockPreflight(region, modelId, {
        ...modelRequestDefaults,
        ...(serviceTier ? { serviceTier } : {})
      });
      process.stdout.write("Preflight succeeded.\n");
    }

    const pricingSeed = {
      ...modelPricingDefaults,
      ...existingProfile
    };
    let pricingOverrides = {};
    if (!hasModelPricingData) {
      const includePricing = await askBoolean(rl, "Configure optional pricing fields", false);
      pricingOverrides = includePricing ? await askPricingFields(rl, pricingSeed) : {};
    }

    const nextProfile = cleanUndefined({
      provider: "bedrock",
      region,
      modelId,
      serviceTier,
      supportsConditionalToolSchemas,
      ...modelRequestDefaults,
      ...modelPricingDefaults,
      ...pricingOverrides
    });

    process.stdout.write("\nAbout to write llm profile:\n");
    process.stdout.write(`${JSON.stringify(nextProfile, null, 2)}\n\n`);

    const confirmWrite = await askBoolean(rl, "Write this llm profile", true);
    if (!confirmWrite) {
      process.stdout.write("Canceled. No files were changed.\n");
      return;
    }

    await writeJsonFile(llmProfilePath, nextProfile);

    const currentWorkspaceDefault = String(workspaceConfig.llm || "").trim();
    const setDefault = await askBoolean(
      rl,
      "Set this llm as the workspace default?",
      !currentWorkspaceDefault || currentWorkspaceDefault === profileName
    );
    if (setDefault) {
      await updateWorkspaceLlmDefault(workspaceConfigPath, profileName);
    }

    process.stdout.write(`\nWrote ${llmProfilePath}\n`);
    if (setDefault) {
      process.stdout.write(`Updated ${workspaceConfigPath} with llm='${profileName}'\n`);
    }
  } finally {
    rl.close();
  }
}

function buildNonInteractiveProfile(seed, options) {
  const region = resolveBedrockCatalogRegion(firstDefined(options.region, seed.region, DEFAULT_LLM_PROFILE.region));
  const baseModelId = firstDefined(options.modelId, seed.modelId, DEFAULT_LLM_PROFILE.modelId);
  const inferenceProfileOptions = getModelInferenceProfileOptions(region, baseModelId);
  const inferenceProfile = normalizeInferenceProfileScope(
    firstDefined(
      options.inferenceProfile,
      seed.inferenceProfile,
      inferInferenceProfileScope(baseModelId),
      inferenceProfileOptions[0]
    ),
    inferenceProfileOptions
  );
  const modelId = applyInferenceProfileScope(baseModelId, inferenceProfile, inferenceProfileOptions);
  const serviceTierOptions = getModelServiceTierOptions(region, modelId);
  const serviceTier = normalizeServiceTier(
    firstDefined(options.serviceTier, seed.serviceTier, serviceTierOptions[0]),
    serviceTierOptions
  );
  const modelRequestDefaults = getModelRequestDefaults(region, modelId);
  const modelPricingDefaults = getModelPricingDefaults(region, modelId, {
    serviceTier,
    inferenceProfile
  });
  const supportsConditionalToolSchemas = getModelSupportsConditionalToolSchemas(region, modelId);

  return cleanUndefined({
    provider: "bedrock",
    region,
    modelId,
    serviceTier,
    supportsConditionalToolSchemas,
    ...modelRequestDefaults,
    ...modelPricingDefaults
  });
}

async function askModelSelection(rl, region, defaultModelId) {
  const recommended = recommendedForRegion(region);
  if (recommended.length === 0) {
    process.stdout.write(`No recommended models for region '${region}'. Please enter model ID manually.\n`);
    const modelId = await askText(rl, "Model ID", defaultModelId);
    return {
      modelId,
      modelRequestDefaults: getModelRequestDefaults(region, modelId)
    };
  }

  process.stdout.write("\nRecommended Bedrock models:\n");
  process.stdout.write("0. Enter custom model ID\n");
  for (let i = 0; i < recommended.length; i += 1) {
    const item = recommended[i];
    process.stdout.write(`${i + 1}. ${item.label} (${item.modelId})\n`);
  }
  process.stdout.write("\n");

  const defaultChoice = inferDefaultModelOption(recommended, defaultModelId);

  while (true) {
    const choiceRaw = await askText(rl, "Select model option", defaultChoice);
    const choice = Number(choiceRaw);
    if (!Number.isInteger(choice) || choice < 0 || choice > recommended.length) {
      process.stdout.write("Please enter a valid option number.\n");
      continue;
    }

    if (choice === 0) {
      const modelId = await askText(rl, "Model ID", defaultModelId);
      return {
        modelId,
        modelRequestDefaults: getModelRequestDefaults(region, modelId)
      };
    }

    const selected = recommended[choice - 1];
    return {
      modelId: selected.modelId,
      modelRequestDefaults: getModelRequestDefaults(region, selected.modelId)
    };
  }
}

function inferDefaultModelOption(recommended, defaultModelId) {
  const normalizedDefault = stripInferenceProfilePrefix(String(defaultModelId || "").trim()).toLowerCase();
  if (!normalizedDefault) {
    return "1";
  }

  const matchedIndex = recommended.findIndex((item) =>
    stripInferenceProfilePrefix(String(item.modelId || "").trim()).toLowerCase() === normalizedDefault
  );

  if (matchedIndex === -1) {
    return "0";
  }

  return String(matchedIndex + 1);
}

function recommendedForRegion(region) {
  return recommendedBedrockModelsForRegion(region);
}

function askBedrockRegionChoice(rl, defaultRegion) {
  const availableRegions = getAvailableBedrockRegions();
  if (availableRegions.length === 0) {
    return Promise.resolve(String(defaultRegion || DEFAULT_LLM_PROFILE.region));
  }

  if (availableRegions.length === 1) {
    return Promise.resolve(availableRegions[0]);
  }

  const normalizedDefault = resolveBedrockCatalogRegion(defaultRegion);
  return askChoice(rl, "Bedrock region", availableRegions, normalizedDefault);
}

function getAvailableBedrockRegions() {
  return [...RECOMMENDED_BEDROCK_MODELS_BY_REGION.keys()].sort((a, b) => a.localeCompare(b));
}

function resolveBedrockCatalogRegion(region) {
  const normalizedRegion = String(region || "").toLowerCase().trim();
  if (!normalizedRegion) {
    return getAvailableBedrockRegions()[0] || String(DEFAULT_LLM_PROFILE.region || "us-east-1");
  }

  if (RECOMMENDED_BEDROCK_MODELS_BY_REGION.has(normalizedRegion)) {
    return normalizedRegion;
  }

  return getAvailableBedrockRegions()[0] || normalizedRegion;
}

function recommendedBedrockModelsForRegion(region) {
  const normalizedRegion = resolveBedrockCatalogRegion(region);
  return RECOMMENDED_BEDROCK_MODELS_BY_REGION.get(normalizedRegion) || [];
}

async function askInferenceProfileChoice(rl, modelId, defaultScope, availableScopes) {
  if (!Array.isArray(availableScopes) || availableScopes.length === 0) {
    return undefined;
  }

  if (availableScopes.length === 1) {
    return normalizeInferenceProfileScope(defaultScope, availableScopes) || availableScopes[0];
  }

  return askChoice(
    rl,
    "Inference profile scope",
    availableScopes,
    normalizeInferenceProfileScope(defaultScope, availableScopes) || inferInferenceProfileScope(modelId) || availableScopes[0]
  );
}

function getModelInferenceProfileOptions(region, modelId) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched || !Array.isArray(matched.inferenceProfiles)) {
    return [];
  }

  return matched.inferenceProfiles
    .map((scope) => String(scope || "").toLowerCase().trim())
    .filter(Boolean);
}

async function askServiceTierChoice(rl, modelId, defaultTier, availableTiers) {
  if (!Array.isArray(availableTiers) || availableTiers.length === 0) {
    return undefined;
  }

  if (availableTiers.length === 1) {
    return normalizeServiceTier(defaultTier, availableTiers) || availableTiers[0];
  }

  return askChoice(
    rl,
    "Service tier",
    availableTiers,
    normalizeServiceTier(defaultTier, availableTiers) || availableTiers[0]
  );
}

function getModelServiceTierOptions(region, modelId) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched || !Array.isArray(matched.serviceTiers)) {
    return [];
  }

  const knownTiers = new Set(["default", "priority", "flex", "reserved"]);

  return [...new Set(matched.serviceTiers
    .map((tier) => String(tier || "").toLowerCase().trim())
    .filter((tier) => knownTiers.has(tier)))];
}

function getModelSupportsConditionalToolSchemas(region, modelId) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched) {
    return true;
  }

  if (matched.supportsConditionalToolSchemas === false) {
    return false;
  }

  return true;
}

function normalizeServiceTier(value, availableTiers = []) {
  const normalized = String(value || "").toLowerCase().trim();
  if (!normalized) {
    return undefined;
  }

  if (!Array.isArray(availableTiers) || availableTiers.length === 0) {
    const known = ["default", "priority", "flex", "reserved"];
    return known.includes(normalized) ? normalized : undefined;
  }

  return availableTiers.includes(normalized) ? normalized : undefined;
}

function applyInferenceProfileScope(modelId, scope, availableScopes = []) {
  const normalizedModelId = String(modelId || "").trim();
  const normalizedScope = normalizeInferenceProfileScope(scope, availableScopes);
  if (!normalizedModelId || !normalizedScope) {
    return normalizedModelId;
  }

  const canonical = stripInferenceProfilePrefix(normalizedModelId, availableScopes);
  return `${normalizedScope}.${canonical}`;
}

function normalizeInferenceProfileScope(value, availableScopes = []) {
  const normalized = String(value || "").toLowerCase().trim();
  if (!normalized) {
    return undefined;
  }

  if (!Array.isArray(availableScopes) || availableScopes.length === 0) {
    return undefined;
  }

  return availableScopes.includes(normalized) ? normalized : undefined;
}

function inferInferenceProfileScope(modelId) {
  const normalized = String(modelId || "").toLowerCase().trim();
  if (normalized.startsWith("global.anthropic.")) {
    return "global";
  }
  if (normalized.startsWith("us.anthropic.")) {
    return "us";
  }
  return undefined;
}

function stripInferenceProfilePrefix(modelId, availableScopes = []) {
  const normalized = String(modelId || "").trim();

  const scopes = Array.isArray(availableScopes) && availableScopes.length > 0
    ? availableScopes
    : ["global", "us"];

  for (const scope of scopes) {
    const prefix = `${scope}.`;
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      return normalized.slice(prefix.length);
    }
  }

  return normalized;
}

function getModelRequestDefaults(region, modelId) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched) {
    return {};
  }

  return cleanUndefined({
    inferenceConfig: clonePlainObject(matched.inferenceConfig),
    additionalModelRequestFields: clonePlainObject(matched.additionalModelRequestFields)
  });
}

function getModelPricingDefaults(region, modelId, context = {}) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched) {
    return {};
  }

  let pricingFields = {};
  if (isPlainObject(matched.pricing)) {
    pricingFields = resolveContextualPricing(matched.pricing, {
      region,
      serviceTier: context.serviceTier,
      inferenceProfile: context.inferenceProfile || inferInferenceProfileScope(modelId)
    });
  }

  if ((!pricingFields || Object.keys(pricingFields).length === 0) && isPlainObject(matched.pricingFields)) {
    pricingFields = matched.pricingFields;
  }

  if (!isPlainObject(pricingFields)) {
    return {};
  }

  return cleanUndefined({
    inputPrice: toFiniteNumberOrUndefined(firstDefined(pricingFields.inputPrice, pricingFields.input)),
    outputPrice: toFiniteNumberOrUndefined(firstDefined(pricingFields.outputPrice, pricingFields.output)),
    cacheReadPrice: toFiniteNumberOrUndefined(firstDefined(pricingFields.cacheReadPrice, pricingFields.cacheRead)),
    cacheWritePrice: toFiniteNumberOrUndefined(firstDefined(pricingFields.cacheWritePrice, pricingFields.cacheWrite)),
    currency: typeof pricingFields.currency === "string" ? pricingFields.currency.trim() : undefined,
    tokenUnit: toFiniteNumberOrUndefined(pricingFields.tokenUnit)
  });
}

function modelHasPricingData(region, modelId) {
  const matched = findRecommendedModel(region, modelId);
  if (!matched) {
    return false;
  }

  return isPlainObject(matched.pricing) || isPlainObject(matched.pricingFields);
}

function resolveContextualPricing(pricing, context) {
  const normalizedRegion = String(context.region || "").toLowerCase().trim();
  const normalizedServiceTier = String(context.serviceTier || "").toLowerCase().trim();
  const normalizedInferenceProfile = String(context.inferenceProfile || "").toLowerCase().trim();

  const resolved = {};
  mergePricingFields(resolved, pricing.defaults);
  mergePricingFields(resolved, pricing.byRegion?.[normalizedRegion]);
  mergePricingFields(resolved, pricing.byInferenceProfile?.[normalizedInferenceProfile]);
  mergePricingFields(resolved, pricing.byServiceTier?.[normalizedServiceTier]);

  if (Array.isArray(pricing.variants)) {
    for (const variant of pricing.variants) {
      if (!variant || typeof variant !== "object") {
        continue;
      }

      const variantRegion = String(variant.region || "").toLowerCase().trim();
      const variantServiceTier = String(variant.serviceTier || "").toLowerCase().trim();
      const variantInferenceProfile = String(variant.inferenceProfile || "").toLowerCase().trim();

      if (variantRegion && variantRegion !== normalizedRegion) {
        continue;
      }
      if (variantServiceTier && variantServiceTier !== normalizedServiceTier) {
        continue;
      }
      if (variantInferenceProfile && variantInferenceProfile !== normalizedInferenceProfile) {
        continue;
      }

      mergePricingFields(resolved, variant.prices);
    }
  }

  if (pricing.currency && !resolved.currency) {
    resolved.currency = String(pricing.currency);
  }
  if (pricing.tokenUnit !== undefined && resolved.tokenUnit === undefined) {
    resolved.tokenUnit = pricing.tokenUnit;
  }

  return resolved;
}

function mergePricingFields(target, source) {
  if (!isPlainObject(source)) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    target[key] = value;
  }
}

function findRecommendedModel(region, modelId) {
  const normalizedModelId = stripInferenceProfilePrefix(String(modelId || "").trim()).toLowerCase();
  if (!normalizedModelId) {
    return null;
  }

  return recommendedBedrockModelsForRegion(region).find((item) => {
    return stripInferenceProfilePrefix(item.modelId).toLowerCase() === normalizedModelId;
  });
}

function loadRecommendedBedrockModelsByRegion(configDir) {
  const files = discoverRecommendedBedrockModelFiles(configDir);
  const modelsByRegion = new Map();

  for (const file of files) {
    const region = file.region;
    const models = loadRecommendedBedrockModels(file.filePath);
    modelsByRegion.set(region, models);
  }

  return modelsByRegion;
}

function discoverRecommendedBedrockModelFiles(configDir) {
  let entries = [];
  try {
    entries = readdirSync(configDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^[a-z0-9-]+\.json$/i.test(name))
    .map((name) => ({
      region: name.replace(/\.json$/i, "").toLowerCase(),
      filePath: path.join(configDir, name)
    }));

  return discovered;
}

function loadRecommendedBedrockModels(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Recommended Bedrock models file does not exist: ${filePath}`);
  }

  let parsed;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in recommended Bedrock models file '${filePath}': ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Recommended Bedrock models file '${filePath}' must contain an array.`);
  }

  return parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      label: String(entry.label || "").trim(),
      modelId: String(entry.modelId || "").trim(),
      supportsConditionalToolSchemas:
        typeof entry.supportsConditionalToolSchemas === "boolean"
          ? entry.supportsConditionalToolSchemas
          : undefined,
      pricingFields: entry.pricingFields && typeof entry.pricingFields === "object"
        ? entry.pricingFields
        : undefined,
      pricing: isPlainObject(entry.pricing) ? entry.pricing : undefined,
      inferenceProfiles: Array.isArray(entry.inferenceProfiles)
        ? entry.inferenceProfiles.map((scope) => String(scope || "").toLowerCase().trim()).filter(Boolean)
        : undefined,
      serviceTiers: Array.isArray(entry.serviceTiers)
        ? entry.serviceTiers.map((tier) => String(tier || "").toLowerCase().trim()).filter(Boolean)
        : undefined,
      inferenceConfig: isPlainObject(entry.inferenceConfig) ? entry.inferenceConfig : undefined,
      additionalModelRequestFields: isPlainObject(entry.additionalModelRequestFields)
        ? entry.additionalModelRequestFields
        : undefined
    }))
    .filter((entry) => entry.label && entry.modelId);
}

async function askPricingFields(rl, seed) {
  const inputPrice = await askOptionalNumber(rl, "Input price (USD per token unit)", seed.inputPrice);
  const outputPrice = await askOptionalNumber(rl, "Output price (USD per token unit)", seed.outputPrice);
  const cacheReadPrice = await askOptionalNumber(rl, "Cache read price (USD per token unit)", seed.cacheReadPrice);
  const cacheWritePrice = await askOptionalNumber(
    rl,
    "Cache write price (USD per token unit)",
    seed.cacheWritePrice
  );
  const currency = await askOptionalText(rl, "Pricing currency", seed.currency || "USD");
  const tokenUnit = await askOptionalNumber(rl, "Token unit", seed.tokenUnit || 1000000);

  return cleanUndefined({
    inputPrice,
    outputPrice,
    cacheReadPrice,
    cacheWritePrice,
    currency,
    tokenUnit
  });
}

async function runBedrockPreflight(region, modelId, modelRequestDefaults = {}) {
  const client = new BedrockRuntimeClient({ region });
  const inferenceConfig = {
    maxTokens: 20,
    ...(isPlainObject(modelRequestDefaults.inferenceConfig) ? modelRequestDefaults.inferenceConfig : {})
  };

  const buildCommandInput = (includeServiceTier) => ({
    modelId,
    ...(includeServiceTier && toBedrockRequestServiceTier(modelRequestDefaults.serviceTier)
      ? { serviceTier: toBedrockRequestServiceTier(modelRequestDefaults.serviceTier) }
      : {}),
    messages: [
      {
        role: "user",
        content: [{ text: 'Return exactly this JSON: {"ok":true}' }]
      }
    ],
    ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
    ...(isPlainObject(modelRequestDefaults.additionalModelRequestFields)
      ? { additionalModelRequestFields: modelRequestDefaults.additionalModelRequestFields }
      : {})
  });

  try {
    await client.send(new ConverseCommand(buildCommandInput(true)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (toBedrockRequestServiceTier(modelRequestDefaults.serviceTier) && /unexpected field type/i.test(detail)) {
      try {
        await client.send(new ConverseCommand(buildCommandInput(false)));
        return;
      } catch {
        // Fall through to original error below for consistency.
      }
    }
    throw new Error(`Bedrock preflight failed for model '${modelId}' in region '${region}': ${detail}`);
  }
}

function toBedrockRequestServiceTier(value) {
  const normalized = normalizeServiceTier(value);
  if (!normalized || normalized === "default") {
    return undefined;
  }
  return normalized;
}

async function updateWorkspaceLlmDefault(workspaceConfigPath, llmProfileName) {
  const workspaceConfig = await readExistingJsonObject(workspaceConfigPath);
  const next = {
    ...workspaceConfig,
    llm: llmProfileName
  };

  await mkdir(path.dirname(workspaceConfigPath), { recursive: true });
  await writeJsonFile(workspaceConfigPath, next);
}

async function readExistingJsonObject(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = await readFile(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must contain a JSON object");
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON at '${filePath}': ${detail}`);
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeProfileName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-");

  if (!normalized) {
    throw new Error("Profile name cannot be empty.");
  }

  return normalized;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== ""));
}

function toFiniteNumberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

async function askText(rl, label, defaultValue) {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  const trimmed = answer.trim();
  if (!trimmed && defaultValue !== undefined) {
    return String(defaultValue);
  }
  return trimmed;
}

async function askOptionalText(rl, label, defaultValue) {
  const answer = await askText(rl, label, defaultValue || "");
  return answer.trim();
}

async function askBoolean(rl, label, defaultValue) {
  const promptDefault = defaultValue ? "Y/n" : "y/N";

  while (true) {
    const answer = await rl.question(`${label} (${promptDefault}): `);
    const trimmed = answer.trim().toLowerCase();

    if (!trimmed) {
      return Boolean(defaultValue);
    }

    if (["y", "yes", "true", "1"].includes(trimmed)) {
      return true;
    }

    if (["n", "no", "false", "0"].includes(trimmed)) {
      return false;
    }

    process.stdout.write("Please answer yes or no.\n");
  }
}

async function askOptionalNumber(rl, label, defaultValue) {
  while (true) {
    const raw = await askOptionalText(rl, label, defaultValue !== undefined ? String(defaultValue) : "");
    if (!raw) {
      return undefined;
    }

    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    process.stdout.write("Please enter a valid number or leave blank.\n");
  }
}

async function askChoice(rl, label, options, defaultValue) {
  const normalizedDefault = options.includes(defaultValue) ? defaultValue : options[0];

  while (true) {
    const answer = await askText(rl, `${label} (${options.join("/")})`, normalizedDefault);
    const normalized = String(answer || "").toLowerCase().trim();
    if (options.includes(normalized)) {
      return normalized;
    }

    process.stdout.write(`Please choose one of: ${options.join(", ")}\n`);
  }
}
