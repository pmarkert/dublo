import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { PlannerActionSchema } from "../../ports/planner.js";
import { resolveReportPath } from "../../utils/run-reports.js";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import { BlockSchema, createBlockAction, sanitizeBlockName } from "./shared.js";

const REPLAYABLE_ACTIONS = new Set(["click", "fill", "wait_until_gone"]);

export async function importBlockCommand(name, runId, options = {}) {
  const blockName = sanitizeBlockName(name);
  const config = loadScenarioConfig({ workspace: options.workspace });
  const reportPath = runId
    ? resolveReportPath(runId, { workspace: options.workspace })
    : await resolveLatestReportPath(config.outputDir);
  const report = await readRunReport(reportPath);

  if (report.status !== "passed") {
    throw new Error(`Only passed runs can be imported into a block; '${report.runId}' is ${report.status}.`);
  }

  const imported = report.steps
    .filter((step) => step.index > 1 && step.outcome === "ok" && step.plannerAction)
    .map((step) => ({
      index: step.index,
      step,
      action: PlannerActionSchema.parse(step.plannerAction)
    }))
    .filter((entry) => REPLAYABLE_ACTIONS.has(entry.action.payload.action))
    .map((entry) => ({ index: entry.index, action: buildReplayableAction(entry.action, entry.step) }));

  if (imported.length === 0) {
    throw new Error(`Run '${report.runId}' has no successful replayable steps after startup navigation.`);
  }

  const block = BlockSchema.parse({
    version: 1,
    name: blockName,
    source: {
      runId: report.runId,
      steps: imported.map((step) => step.index)
    },
    actions: imported.map((step) => step.action)
  });
  const blockPath = path.join(config.workspace, "blocks", `${blockName}.json`);
  await mkdir(path.dirname(blockPath), { recursive: true });
  await writeAtomically(blockPath, `${JSON.stringify(block, null, 2)}\n`);
  process.stdout.write(`${blockPath}\n`);
}

// Builds a replayable block action. For click/fill it prefers the descriptive
// target captured in the report step (label/text/role/type) over the ephemeral
// per-turn id, so the block resolves against a later run instead of matching
// whatever control happens to be at that DOM position. Adds a URL post-condition
// when the recorded step's URL has a meaningful path.
function buildReplayableAction(plannerAction, step) {
  const payload = plannerAction.payload;
  if (payload.action === "wait_until_gone") {
    return createBlockAction(plannerAction);
  }

  const descriptiveTarget = buildDescriptiveTarget(step.target) || payload.target;
  const rebuilt = {
    reason: plannerAction.reason,
    payload:
      payload.action === "fill"
        ? { action: "fill", target: descriptiveTarget, value: payload.value }
        : { action: "click", target: descriptiveTarget },
    // Recorded identity of the control this step ran against, so a later replay
    // can tell a description match apart from the same control.
    ...(typeof step.fingerprint === "string" && step.fingerprint
      ? { fingerprint: step.fingerprint }
      : {})
  };

  const expect = buildExpectation(step);
  if (expect) rebuilt.expect = expect;
  return createBlockAction(rebuilt);
}

function buildDescriptiveTarget(target) {
  if (!target || typeof target !== "object") return null;
  const descriptive = {};
  for (const key of ["label", "text", "role", "type"]) {
    const value = target[key];
    if (typeof value === "string" && value.trim().length > 0) descriptive[key] = value;
  }
  return Object.keys(descriptive).length > 0 ? descriptive : null;
}

function buildExpectation(step) {
  if (!step || typeof step.url !== "string") return null;
  try {
    const path = new URL(step.url).pathname;
    if (path && path !== "/") return { urlIncludes: path };
  } catch {
    // Non-absolute or unparseable URL; skip the post-condition.
  }
  return null;
}

async function resolveLatestReportPath(outputDir) {
  const latestPath = path.join(outputDir, "latest.json");
  let latest;
  try {
    latest = JSON.parse(await readFile(latestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the latest report manifest at '${latestPath}': ${detail}`);
  }

  if (!latest || typeof latest.reportPath !== "string") {
    throw new Error(`Latest report manifest '${latestPath}' does not contain a report path.`);
  }
  return latest.reportPath;
}

async function readRunReport(reportPath) {
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read report '${reportPath}': ${detail}`);
  }

  if (!report || typeof report.runId !== "string" || typeof report.status !== "string" || !Array.isArray(report.steps)) {
    throw new Error(`Report '${reportPath}' is missing required run metadata.`);
  }
  return report;
}

async function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}