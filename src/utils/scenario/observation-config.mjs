import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_OBSERVATION_CONFIG = {
  controlsSelector:
    "button, a, input, textarea, select, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']",
  // Maximum controls surfaced to the planner per observation. Controls are
  // ranked by relevance (viewport proximity, then relevanceKeywords) before this
  // cap is applied, so truncation drops the least relevant ones. 0 disables the
  // cap (every eligible control is surfaced, at higher token cost).
  maxControls: 150,
  // Optional lowercase keywords that boost matching controls when ranking under
  // the maxControls budget. The runner populates these from the scenario.
  relevanceKeywords: [],
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
  pierceShadow: true,
  includeInferredControls: true,
  maxInferredControls: 20,
};

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