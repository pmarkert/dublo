import fs from "node:fs";
import path from "node:path";
import { loadScenarioConfig } from "./loadScenarioConfig.js";

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function looksLikePath(value) {
  return (
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".json") ||
    value.startsWith(".")
  );
}

export function getRunsOutputDir(options = {}) {
  const config = loadScenarioConfig({ workspace: options.workspace });
  return config.outputDir;
}

export function resolveReportPath(runIdOrPath, options = {}) {
  const rawValue = String(runIdOrPath || "").trim();
  if (!rawValue) {
    throw new Error("A run ID or report.json path is required.");
  }

  const directPath = path.resolve(process.cwd(), rawValue);
  if (isFile(directPath)) {
    return directPath;
  }

  if (isDirectory(directPath)) {
    const nestedReportPath = path.join(directPath, "report.json");
    if (isFile(nestedReportPath)) {
      return nestedReportPath;
    }
  }

  const outputDir = getRunsOutputDir(options);
  const runDirReportPath = path.join(outputDir, rawValue, "report.json");
  if (isFile(runDirReportPath)) {
    return runDirReportPath;
  }

  if (looksLikePath(rawValue)) {
    throw new Error(`Could not find report at '${rawValue}'.`);
  }

  throw new Error(`Could not find run '${rawValue}' under ${outputDir}.`);
}

export function listAvailableRuns(options = {}) {
  const outputDir = getRunsOutputDir(options);

  let entries;
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = path.join(outputDir, entry.name);
      const reportPath = path.join(runDir, "report.json");
      let report = null;
      if (isFile(reportPath)) {
        try {
          report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        } catch {
          report = null;
        }
      }

      return {
        runId: entry.name,
        reportPath,
        status: report?.status || "unknown",
        objective: report?.objective || "",
        finalUrl: report?.finalUrl || "",
        finishedAt: report?.finishedAt || report?.startedAt || "",
      };
    })
    .sort((left, right) => right.runId.localeCompare(left.runId));
}