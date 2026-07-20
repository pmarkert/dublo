import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import type { Command } from "commander";
import {
  DEFAULT_REPORT_GENERATORS,
  generateReportArtifacts
} from "../reporting/report-artifacts.mjs";
import { loadScenarioConfig } from "../utils/loadScenarioConfig.js";
import { listAvailableRuns, resolveReportPath } from "../utils/run-reports.js";

interface WorkspaceOptions {
  workspace?: string;
}

interface ListOptions extends WorkspaceOptions {
  format?: "text" | "json";
  limit?: string;
  status?: "passed" | "failed" | "interrupted";
}

interface ShowOptions extends WorkspaceOptions {
  format?: "text" | "json";
  steps?: boolean;
}

interface OpenOptions extends WorkspaceOptions {
  markdown?: boolean;
  json?: boolean;
}

interface RenderOptions extends WorkspaceOptions {
  open?: boolean;
  report?: string[];
}

interface RunReport {
  runId: string;
  objective: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  finalUrl: string;
  error?: string;
  steps: unknown[];
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Expected --limit to be a positive integer, received '${value}'.`);
  }
  return limit;
}

async function resolveReportReference(
  runId: string | undefined,
  options: WorkspaceOptions
): Promise<string> {
  if (runId) return resolveReportPath(runId, options);

  const config: unknown = loadScenarioConfig({ workspace: options.workspace });
  if (!isRecord(config) || typeof config.outputDir !== "string") {
    throw new Error("Resolved workspace configuration does not contain an output directory.");
  }
  const outputDir = config.outputDir;
  const latestPath = path.join(outputDir, "latest.json");
  let latest: unknown;
  try {
    latest = JSON.parse(await readFile(latestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the latest report manifest at '${latestPath}': ${detail}`, {
      cause: error
    });
  }

  if (!isRecord(latest) || typeof latest.reportPath !== "string") {
    throw new Error(`Latest report manifest '${latestPath}' does not contain a report path.`);
  }
  const reportPath = latest.reportPath;
  if (existsSync(reportPath)) {
    return reportPath;
  }

  if (typeof latest.runId === "string") {
    const relocatedReportPath = path.join(outputDir, latest.runId, "report.json");
    if (existsSync(relocatedReportPath)) {
      return relocatedReportPath;
    }
  }

  throw new Error(`Latest report does not exist at '${reportPath}'.`);
}

async function readReport(reportPath: string): Promise<RunReport> {
  const parsed: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Report '${reportPath}' must contain a JSON object.`);
  }

  const report = parsed as Partial<RunReport>;
  if (
    typeof report.runId !== "string" ||
    typeof report.status !== "string" ||
    !Array.isArray(report.steps)
  ) {
    throw new Error(`Report '${reportPath}' is missing required run metadata.`);
  }

  return {
    runId: report.runId,
    objective: typeof report.objective === "string" ? report.objective : "",
    status: report.status,
    startedAt: typeof report.startedAt === "string" ? report.startedAt : "",
    finishedAt: typeof report.finishedAt === "string" ? report.finishedAt : "",
    finalUrl: typeof report.finalUrl === "string" ? report.finalUrl : "",
    ...(typeof report.error === "string" ? { error: report.error } : {}),
    steps: report.steps
  };
}

function writeReportSummary(report: RunReport, includeSteps: boolean): void {
  process.stdout.write(`Run ID: ${report.runId}\n`);
  process.stdout.write(`Status: ${report.status}\n`);
  process.stdout.write(`Started: ${report.startedAt}\n`);
  process.stdout.write(`Finished: ${report.finishedAt}\n`);
  process.stdout.write(`Objective: ${report.objective}\n`);
  process.stdout.write(`Final URL: ${report.finalUrl}\n`);
  if (report.error) process.stdout.write(`Error: ${report.error}\n`);
  process.stdout.write(`Steps: ${report.steps.length}\n`);
  if (includeSteps) writeJson(report.steps);
}

async function openInDefaultViewer(targetPath: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args =
    process.platform === "darwin"
      ? [targetPath]
      : process.platform === "win32"
        ? ["/c", "start", "", targetPath]
        : [targetPath];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      if (process.platform !== "win32") child.unref();
      resolve();
    });
  });
}

export function registerReportCommands(program: Command): void {
  const report = program.command("report").description("Inspect and render persisted run reports");

  report
    .command("list")
    .description("List reports in reverse chronological order")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--limit <count>", "Maximum report count")
    .option("--status <status>", "Filter: passed, failed, or interrupted")
    .option("--format <format>", "Output format: text or json", "text")
    .action((options: ListOptions) => {
      if (options.format !== "text" && options.format !== "json")
        throw new Error("Use text or json for --format.");
      if (options.status && !["passed", "failed", "interrupted"].includes(options.status)) {
        throw new Error("Use passed, failed, or interrupted for --status.");
      }
      const reports = listAvailableRuns(options)
        .filter((entry: { status: string }) => !options.status || entry.status === options.status)
        .slice(0, parsePositiveLimit(options.limit));
      if (options.format === "json") {
        writeJson(reports);
        return;
      }
      if (reports.length === 0) {
        process.stdout.write("No reports found.\n");
        return;
      }
      for (const entry of reports) {
        process.stdout.write(
          `${entry.runId}\t${entry.status}\t${entry.finishedAt}\t${entry.objective}\t${entry.finalUrl}\n`
        );
      }
    });

  report
    .command("show [run-id]")
    .description("Show a report, defaulting to the latest report")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--format <format>", "Output format: text or json", "text")
    .option("--steps", "Include per-step details in text output")
    .action(async (runId: string | undefined, options: ShowOptions) => {
      if (options.format !== "text" && options.format !== "json")
        throw new Error("Use text or json for --format.");
      const reportData = await readReport(await resolveReportReference(runId, options));
      if (options.format === "json") writeJson(reportData);
      else writeReportSummary(reportData, Boolean(options.steps));
    });

  report
    .command("render [run-id]")
    .description("Render report artifacts, defaulting to the latest report")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--report <id>", "Report renderer to generate (repeatable)", collectOptionValues)
    .option("--open", "Open generated report artifacts")
    .action(async (runId: string | undefined, options: RenderOptions) => {
      const result = await generateReportArtifacts(
        await resolveReportReference(runId, options),
        options.report?.length ? options.report : DEFAULT_REPORT_GENERATORS
      );
      for (const generated of result.generated) {
        process.stdout.write(`${generated.outputPath}\n`);
        if (options.open) await openInDefaultViewer(generated.outputPath);
      }
    });

  report
    .command("open [run-id]")
    .description("Open a rendered report, defaulting to the latest report")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--markdown", "Open the Markdown summary")
    .option("--json", "Open report.json")
    .action(async (runId: string | undefined, options: OpenOptions) => {
      if (options.markdown && options.json)
        throw new Error("Use either --markdown or --json, not both.");
      const reportPath = await resolveReportReference(runId, options);
      const artifactName = options.json
        ? "report.json"
        : options.markdown
          ? "summary.md"
          : "summary.html";
      const artifactPath = path.join(path.dirname(reportPath), artifactName);
      if (!existsSync(artifactPath)) {
        throw new Error(
          `Report artifact '${artifactName}' does not exist. Run 'dublo report render' first.`
        );
      }
      await openInDefaultViewer(artifactPath);
      process.stdout.write(`${artifactPath}\n`);
    });
}

function collectOptionValues(value: string, previous: string[] | undefined): string[] {
  return previous ? [...previous, value] : [value];
}
