import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

export const SuiteTaskSchema = z
  .object({
    scenario: z.string().trim().min(1),
    context: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]).optional(),
    llm: z.string().trim().min(1).optional(),
    persona: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional()
  })
  .strict();

export const SuiteMatrixSchema = z
  .object({
    scenarios: z.array(z.string().trim().min(1)).min(1),
    contexts: z
      .array(z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]))
      .optional()
  })
  .strict();

export const SuiteManifestSchema = z
  .object({
    workspace: z.string().trim().min(1).optional(),
    concurrency: z.number().int().positive().max(20).optional(),
    headless: z.boolean().optional(),
    outputDir: z.string().trim().min(1).optional(),
    llm: z.string().trim().min(1).optional(),
    persona: z.string().trim().min(1).optional(),
    tasks: z.array(SuiteTaskSchema).optional(),
    matrix: SuiteMatrixSchema.optional()
  })
  .strict()
  .refine(
    (data) => (data.tasks !== undefined && data.tasks.length > 0) || data.matrix !== undefined,
    { message: 'Suite manifest must include "tasks", "matrix", or both' }
  );

export type SuiteTask = z.infer<typeof SuiteTaskSchema>;
export type SuiteMatrix = z.infer<typeof SuiteMatrixSchema>;
export type SuiteManifest = z.infer<typeof SuiteManifestSchema>;

export interface ExpandedTask {
  index: number;
  label: string;
  dirLabel: string;
  scenario: string;
  context: string[];
  llm: string | undefined;
  persona: string | undefined;
  taskDir: string;
}

export interface TaskResult {
  index: number;
  label: string;
  scenario: string;
  context: string[];
  status: "passed" | "failed" | "error";
  runId: string | undefined;
  runDir: string | undefined;
  reportPath: string | undefined;
  summaryHtmlPath: string | undefined;
  tokenUsage: SuiteTokenUsage | undefined;
  costTotal: SuiteCostTotal | undefined;
  durationMs: number;
  errorMessage: string | undefined;
}

export interface SuiteTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  plannerCalls: number;
}

export interface SuiteCostTotal {
  currency: string;
  total: number;
}

export interface SuiteResult {
  suiteId: string;
  suiteDir: string;
  manifestPath: string;
  startedAt: string;
  finishedAt: string;
  concurrency: number;
  tasks: TaskResult[];
  passed: number;
  failed: number;
  errored: number;
  total: number;
  tokenUsage?: SuiteTokenUsage;
  costTotals?: SuiteCostTotal[];
}

export interface SuiteRunReport {
  runId: string;
  objective: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  finalUrl: string;
  error?: string;
  steps: TaskResult[];
  tokenUsage?: SuiteTokenUsage;
  costTotals?: SuiteCostTotal[];
  suite: SuiteResult;
}

function sanitizeDirName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeContextArray(context: string | string[] | undefined): string[] {
  if (context === undefined) return [];
  if (typeof context === "string") return [context];
  return context;
}

export function createSuiteRunReport(result: SuiteResult): SuiteRunReport {
  const error =
    result.failed > 0 || result.errored > 0
      ? `${result.failed} failed, ${result.errored} errored task${result.total === 1 ? "" : "s"}.`
      : undefined;

  return {
    runId: result.suiteId,
    objective: `Suite ${result.suiteId}`,
    status: result.passed === result.total ? "passed" : "failed",
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    finalUrl: "",
    ...(error ? { error } : {}),
    steps: result.tasks,
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    ...(result.costTotals ? { costTotals: result.costTotals } : {}),
    suite: result
  };
}

export function expandTasks(manifest: SuiteManifest, suiteDir: string): ExpandedTask[] {
  const expanded: ExpandedTask[] = [];

  function addTask(
    scenario: string,
    context: string[],
    llm: string | undefined,
    persona: string | undefined,
    customLabel?: string
  ): void {
    const index = expanded.length;
    const label =
      customLabel ?? (context.length > 0 ? `${scenario}_${context.join("+")}` : scenario);
    const dirLabel = sanitizeDirName(label) || `task_${index}`;
    const taskDir = path.join(
      suiteDir,
      "tasks",
      `${String(index + 1).padStart(3, "0")}_${dirLabel}`
    );
    expanded.push({ index, label, dirLabel, scenario, context, llm, persona, taskDir });
  }

  if (manifest.matrix) {
    const { scenarios, contexts } = manifest.matrix;
    const contextSets =
      contexts && contexts.length > 0 ? contexts.map(normalizeContextArray) : [[]];
    for (const scenario of scenarios) {
      for (const contextSet of contextSets) {
        addTask(scenario, contextSet, manifest.llm, manifest.persona);
      }
    }
  }

  for (const task of manifest.tasks ?? []) {
    addTask(
      task.scenario,
      normalizeContextArray(task.context),
      task.llm ?? manifest.llm,
      task.persona ?? manifest.persona,
      task.label
    );
  }

  return expanded;
}

interface LatestJson {
  runId?: string;
  artifactsDir?: string;
  reportPath?: string;
  summaryHtmlPath?: string;
  status?: string;
  costEstimate?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTokenUsage(value: unknown): SuiteTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = numericValue(value.totalTokens);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens: numericValue(value.inputTokens) ?? 0,
    outputTokens: numericValue(value.outputTokens) ?? 0,
    totalTokens,
    cacheReadInputTokens: numericValue(value.cacheReadInputTokens) ?? 0,
    cacheWriteInputTokens: numericValue(value.cacheWriteInputTokens) ?? 0,
    plannerCalls: numericValue(value.plannerCalls) ?? 0
  };
}

function parseCostTotal(value: unknown): SuiteCostTotal | undefined {
  if (!isRecord(value) || typeof value.currency !== "string" || !isRecord(value.costs)) {
    return undefined;
  }
  const total = numericValue(value.costs.total);
  return total === undefined ? undefined : { currency: value.currency, total };
}

async function readTaskMetrics(reportPath: string | undefined): Promise<{
  tokenUsage: SuiteTokenUsage | undefined;
  costTotal: SuiteCostTotal | undefined;
}> {
  if (!reportPath) return { tokenUsage: undefined, costTotal: undefined };
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    if (!isRecord(report)) return { tokenUsage: undefined, costTotal: undefined };
    return {
      tokenUsage: parseTokenUsage(report.tokenUsage),
      costTotal: parseCostTotal(report.costEstimate)
    };
  } catch {
    return { tokenUsage: undefined, costTotal: undefined };
  }
}

function aggregateTaskMetrics(tasks: TaskResult[]): {
  tokenUsage: SuiteTokenUsage | undefined;
  costTotals: SuiteCostTotal[] | undefined;
} {
  const tasksWithTokenUsage = tasks.filter((task) => task.tokenUsage !== undefined);
  const tokenUsage = tasksWithTokenUsage.length === 0
    ? undefined
    : tasksWithTokenUsage.reduce<SuiteTokenUsage>(
        (total, task) => ({
          inputTokens: total.inputTokens + (task.tokenUsage?.inputTokens ?? 0),
          outputTokens: total.outputTokens + (task.tokenUsage?.outputTokens ?? 0),
          totalTokens: total.totalTokens + (task.tokenUsage?.totalTokens ?? 0),
          cacheReadInputTokens: total.cacheReadInputTokens + (task.tokenUsage?.cacheReadInputTokens ?? 0),
          cacheWriteInputTokens: total.cacheWriteInputTokens + (task.tokenUsage?.cacheWriteInputTokens ?? 0),
          plannerCalls: total.plannerCalls + (task.tokenUsage?.plannerCalls ?? 0)
        }),
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          plannerCalls: 0
        }
      );
  const costsByCurrency = new Map<string, number>();
  for (const task of tasks) {
    if (!task.costTotal) continue;
    costsByCurrency.set(task.costTotal.currency, (costsByCurrency.get(task.costTotal.currency) ?? 0) + task.costTotal.total);
  }
  const costTotals = Array.from(costsByCurrency, ([currency, total]) => ({
    currency,
    total: Number(total.toFixed(10))
  }));

  return { tokenUsage, costTotals: costTotals.length > 0 ? costTotals : undefined };
}

async function readLatestJson(taskDir: string): Promise<LatestJson> {
  const latestPath = path.join(taskDir, "latest.json");
  try {
    const raw = await readFile(latestPath, "utf8");
    return JSON.parse(raw) as LatestJson;
  } catch {
    return {};
  }
}

function resolveCliCommand(): { nodeExe: string; cliFlags: string[]; cliPath: string } {
  const nodeExe = process.execPath;
  const cliPath = process.argv[1] ?? "";
  const isTsSource = cliPath.endsWith(".ts") || cliPath.endsWith(".mts");
  const cliFlags = isTsSource ? ["--import", "tsx"] : [];
  return { nodeExe, cliFlags, cliPath };
}

function buildTaskArgs(task: ExpandedTask, workspace: string, forceHeadless: boolean): string[] {
  const args: string[] = [
    "run",
    task.scenario,
    "--workspace",
    workspace,
    "--output-dir",
    task.taskDir
  ];
  if (forceHeadless) args.push("--headless");
  for (const ctx of task.context) {
    args.push("--context", ctx);
  }
  if (task.llm) args.push("--llm", task.llm);
  if (task.persona) args.push("--persona", task.persona);
  return args;
}

export interface SuiteRunOptions {
  workspace: string;
  headless: boolean;
  onTaskStart?: (task: ExpandedTask) => void;
  onTaskComplete?: (result: TaskResult) => void;
}

async function runTask(task: ExpandedTask, options: SuiteRunOptions): Promise<TaskResult> {
  const startedAt = Date.now();
  await mkdir(task.taskDir, { recursive: true });

  const { nodeExe, cliFlags, cliPath } = resolveCliCommand();
  const taskArgs = buildTaskArgs(task, options.workspace, options.headless);
  const spawnArgs = [...cliFlags, cliPath, ...taskArgs];
  const logPath = path.join(task.taskDir, "task.log");

  return new Promise<TaskResult>((resolve) => {
    const child = spawn(nodeExe, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    const logChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      logChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      logChunks.push(chunk);
    });

    const finish = async (exitCode: number | null, spawnError?: Error): Promise<void> => {
      const logContent = Buffer.concat(logChunks).toString("utf8");
      try {
        await writeFile(logPath, logContent, "utf8");
      } catch {
        // best-effort log write
      }

      const durationMs = Date.now() - startedAt;

      if (spawnError != null || exitCode !== 0) {
        const errorLines = logContent.trim().split("\n").slice(-5).join("\n");
        resolve({
          index: task.index,
          label: task.label,
          scenario: task.scenario,
          context: task.context,
          status: "error",
          runId: undefined,
          runDir: undefined,
          reportPath: undefined,
          summaryHtmlPath: undefined,
          tokenUsage: undefined,
          costTotal: undefined,
          durationMs,
          errorMessage:
            spawnError?.message ??
            (errorLines || `Process exited with code ${exitCode ?? "unknown"}`)
        });
        return;
      }

      const latest = await readLatestJson(task.taskDir);
      const reportStatus = latest.status ?? "unknown";
      const taskStatus: TaskResult["status"] =
        reportStatus === "passed" ? "passed" : reportStatus === "failed" ? "failed" : "error";
      const metrics = await readTaskMetrics(latest.reportPath);

      resolve({
        index: task.index,
        label: task.label,
        scenario: task.scenario,
        context: task.context,
        status: taskStatus,
        runId: latest.runId,
        runDir: latest.artifactsDir,
        reportPath: latest.reportPath,
        summaryHtmlPath: latest.summaryHtmlPath,
        tokenUsage: metrics.tokenUsage,
        costTotal: metrics.costTotal ?? parseCostTotal(latest.costEstimate),
        durationMs,
        errorMessage: undefined
      });
    };

    child.on("close", (code) => {
      void finish(code);
    });

    child.on("error", (err) => {
      void finish(null, err);
    });
  });
}

async function runWithConcurrency(
  tasks: ExpandedTask[],
  limit: number,
  options: SuiteRunOptions
): Promise<TaskResult[]> {
  const results: TaskResult[] = new Array(tasks.length) as TaskResult[];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      const task = tasks[i];
      if (!task) break;
      options.onTaskStart?.(task);
      const result = await runTask(task, options);
      results[i] = result;
      options.onTaskComplete?.(result);
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

export async function runSuite(
  manifest: SuiteManifest,
  manifestPath: string,
  suiteDir: string,
  options: SuiteRunOptions
): Promise<SuiteResult> {
  const suiteId = path.basename(suiteDir);
  const startedAt = new Date();
  const concurrency = manifest.concurrency ?? 3;
  const tasks = expandTasks(manifest, suiteDir);

  await mkdir(suiteDir, { recursive: true });

  const taskResults = await runWithConcurrency(tasks, concurrency, options);

  const finishedAt = new Date();

  const passed = taskResults.filter((r) => r.status === "passed").length;
  const failed = taskResults.filter((r) => r.status === "failed").length;
  const errored = taskResults.filter((r) => r.status === "error").length;
  const metrics = aggregateTaskMetrics(taskResults);

  const suiteResult: SuiteResult = {
    suiteId,
    suiteDir,
    manifestPath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    concurrency,
    tasks: taskResults,
    passed,
    failed,
    errored,
    total: taskResults.length,
    ...(metrics.tokenUsage ? { tokenUsage: metrics.tokenUsage } : {}),
    ...(metrics.costTotals ? { costTotals: metrics.costTotals } : {})
  };

  await writeFile(
    path.join(suiteDir, "suite.json"),
    JSON.stringify(suiteResult, null, 2) + "\n",
    "utf8"
  );

  return suiteResult;
}
