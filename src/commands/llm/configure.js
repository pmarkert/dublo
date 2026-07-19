import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const RECOMMENDED_BEDROCK_MODELS = [
  {
    label: "Amazon Nova Micro (fast)",
    modelId: "amazon.nova-micro-v1:0",
    regions: ["us-east-1", "us-west-2"]
  },
  {
    label: "Amazon Nova Lite (balanced)",
    modelId: "amazon.nova-lite-v1:0",
    regions: ["us-east-1", "us-west-2"]
  },
  {
    label: "Amazon Nova Pro (high quality)",
    modelId: "amazon.nova-pro-v1:0",
    regions: ["us-east-1", "us-west-2"]
  },
  {
    label: "Anthropic Claude 3.5 Sonnet v2",
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    regions: ["us-east-1", "us-west-2"]
  },
  {
    label: "Anthropic Claude 3.7 Sonnet",
    modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
    regions: ["us-east-1", "us-west-2"]
  }
];

const DEFAULT_LLM_PROFILE = {
  provider: "bedrock",
  region: firstDefined(process.env.AWS_REGION, "us-east-1"),
  modelId: "amazon.nova-pro-v1:0"
};

export async function configureLlmCommand(options = {}) {
  const workspaceInput = firstDefined(options.workspace, process.env.DUBLO_WORKSPACE, "./.dublo");
  const workspacePath = path.resolve(process.cwd(), workspaceInput);
  const llmDir = path.join(workspacePath, "llm");
  const workspaceConfigPath = path.join(workspacePath, "config.json");

  await mkdir(llmDir, { recursive: true });

  const profileName = sanitizeProfileName(firstDefined(options.profile, options.name, "default"));
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

    const region = await askText(rl, "Bedrock region", String(seed.region || DEFAULT_LLM_PROFILE.region));
    const modelId = await askModelId(rl, region, String(seed.modelId || DEFAULT_LLM_PROFILE.modelId));

    const runPreflight = await askBoolean(rl, "Run Bedrock preflight check now", true);
    if (runPreflight) {
      await runBedrockPreflight(region, modelId);
      process.stdout.write("Preflight succeeded.\n");
    }

    const includePricing = await askBoolean(rl, "Configure optional pricing fields", false);
    const pricingFields = includePricing ? await askPricingFields(rl, existingProfile) : {};

    const nextProfile = cleanUndefined({
      provider: "bedrock",
      region,
      modelId,
      ...pricingFields
    });

    process.stdout.write("\nAbout to write llm profile:\n");
    process.stdout.write(`${JSON.stringify(nextProfile, null, 2)}\n\n`);

    const confirmWrite = await askBoolean(rl, "Write this llm profile", true);
    if (!confirmWrite) {
      process.stdout.write("Canceled. No files were changed.\n");
      return;
    }

    await writeJsonFile(llmProfilePath, nextProfile);

    const setDefault = await askBoolean(rl, `Set workspace config llm to '${profileName}'`, true);
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
  return cleanUndefined({
    provider: "bedrock",
    region: firstDefined(options.region, seed.region, DEFAULT_LLM_PROFILE.region),
    modelId: firstDefined(options.modelId, seed.modelId, DEFAULT_LLM_PROFILE.modelId)
  });
}

async function askModelId(rl, region, defaultModelId) {
  const chooseFromRecommended = await askBoolean(
    rl,
    "Choose model from recommended list (otherwise enter model ID manually)",
    true
  );

  if (!chooseFromRecommended) {
    return askText(rl, "Model ID", defaultModelId);
  }

  const recommended = recommendedForRegion(region);
  if (recommended.length === 0) {
    process.stdout.write(`No recommended models for region '${region}'. Please enter model ID manually.\n`);
    return askText(rl, "Model ID", defaultModelId);
  }

  process.stdout.write("\nRecommended Bedrock models:\n");
  for (let i = 0; i < recommended.length; i += 1) {
    const item = recommended[i];
    process.stdout.write(`${i + 1}. ${item.label} (${item.modelId})\n`);
  }
  process.stdout.write(`${recommended.length + 1}. Enter custom model ID\n\n`);

  while (true) {
    const choiceRaw = await askText(rl, "Select model option", "1");
    const choice = Number(choiceRaw);
    if (!Number.isInteger(choice) || choice < 1 || choice > recommended.length + 1) {
      process.stdout.write("Please enter a valid option number.\n");
      continue;
    }

    if (choice === recommended.length + 1) {
      return askText(rl, "Model ID", defaultModelId);
    }

    return recommended[choice - 1].modelId;
  }
}

function recommendedForRegion(region) {
  const normalizedRegion = String(region || "").toLowerCase().trim();
  return RECOMMENDED_BEDROCK_MODELS.filter((item) =>
    item.regions.some((candidateRegion) => candidateRegion.toLowerCase() === normalizedRegion)
  );
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

async function runBedrockPreflight(region, modelId) {
  const client = new BedrockRuntimeClient({ region });
  const command = new ConverseCommand({
    modelId,
    messages: [
      {
        role: "user",
        content: [{ text: 'Return exactly this JSON: {"ok":true}' }]
      }
    ],
    inferenceConfig: {
      temperature: 0,
      maxTokens: 20
    }
  });

  try {
    await client.send(command);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bedrock preflight failed for model '${modelId}' in region '${region}': ${detail}`);
  }
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
