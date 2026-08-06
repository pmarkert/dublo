import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DEFAULT_OBSERVATION_CONFIG } from "./observation-defaults.mjs";

function mergeObservationConfig(defaultConfig, overrideConfig) {
  if (!overrideConfig || typeof overrideConfig !== "object" || Array.isArray(overrideConfig)) {
    return { ...defaultConfig };
  }

  const merged = { ...defaultConfig };
  for (const [key, value] of Object.entries(overrideConfig)) {
    if (value === undefined) continue;
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

export function normalizeScreenshotMode(rawValue) {
  const normalized = String(rawValue || "").toLowerCase().trim();
  if (normalized === "fullpage" || normalized === "full-page") return "fullpage";
  if (normalized === "viewport") return "viewport";
  return "none";
}

export async function loadObservationConfig(observationConfigFile) {
  if (!observationConfigFile) return { ...DEFAULT_OBSERVATION_CONFIG };

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