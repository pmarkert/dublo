import process from "node:process";
import { inferSingleLlmProfile, listLlmProfileNames, readJsonObject, resolveLlmProfilePath, resolveWorkspacePath } from "./shared.js";

export async function validateLlmCommand(profile, options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const target = profile || options.name || inferSingleLlmProfile(workspacePath);

  const targets = target ? [target] : listLlmProfileNames(workspacePath);
  if (targets.length === 0) {
    throw new Error("No llm profiles found to validate.");
  }

  let hasErrors = false;
  for (const entry of targets) {
    const profilePath = resolveLlmProfilePath(workspacePath, entry);
    if (!profilePath) {
      process.stdout.write(`FAIL ${entry}: profile could not be resolved\n`);
      hasErrors = true;
      continue;
    }

    try {
      const parsed = await readJsonObject(profilePath, "llm profile");
      validateParsedProfile(parsed, profilePath);
      process.stdout.write(`OK   ${entry} (${profilePath})\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stdout.write(`FAIL ${entry}: ${detail}\n`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    throw new Error("One or more llm profiles are invalid.");
  }
}

function validateParsedProfile(profile, profilePath) {
  const provider = String(profile.provider || "").toLowerCase().trim();
  if (!provider) {
    throw new Error(`LLM profile '${profilePath}' is missing required field 'provider'.`);
  }

  if (provider !== "bedrock" && provider !== "openai-compatible") {
    throw new Error(`LLM profile '${profilePath}' has unsupported provider '${profile.provider}'.`);
  }

  if (provider === "bedrock") {
    if (!profile.region || typeof profile.region !== "string") {
      throw new Error(`LLM profile '${profilePath}' is missing required field 'region'.`);
    }
  }

  if (provider === "openai-compatible") {
    if (!profile.baseUrl || typeof profile.baseUrl !== "string") {
      throw new Error(`LLM profile '${profilePath}' is missing required field 'baseUrl'.`);
    }
    if (!profile.baseUrl.startsWith("http")) {
      throw new Error(`LLM profile '${profilePath}' field 'baseUrl' must start with http or https.`);
    }
  }

  if (!profile.modelId || typeof profile.modelId !== "string") {
    throw new Error(`LLM profile '${profilePath}' is missing required field 'modelId'.`);
  }

  const numericFields = ["inputPrice", "outputPrice", "cacheReadPrice", "cacheWritePrice", "tokenUnit"];
  for (const key of numericFields) {
    if (profile[key] === undefined) {
      continue;
    }

    const parsed = Number(profile[key]);
    if (!Number.isFinite(parsed)) {
      throw new Error(`LLM profile '${profilePath}' has non-numeric '${key}'.`);
    }
  }
}
