import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as yaml from "js-yaml";
import type { Command } from "commander";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import {
	SuiteManifestSchema,
	expandTasks,
	runSuite,
	type ExpandedTask,
	type SuiteManifest,
	type TaskResult,
} from "../../utils/suite-runner.js";
import {
	renderSuiteReportHtml,
	renderSuiteReportMarkdown,
} from "../../reporting/suite-report.js";

function formatSuiteId(): string {
	return `suite-${new Date().toISOString().replace(/[.:]/g, "-")}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function statusLabel(result: TaskResult): string {
	if (result.status === "passed") return "PASS";
	if (result.status === "failed") return "FAIL";
	return "ERROR";
}

async function loadManifest(manifestPath: string): Promise<SuiteManifest> {
	const resolved = path.resolve(process.cwd(), manifestPath);
	let raw: string;
	try {
		raw = await readFile(resolved, "utf8");
	} catch {
		throw new Error(`Cannot read suite manifest '${resolved}'.`);
	}

	const ext = path.extname(resolved).toLowerCase();
	let parsed: unknown;
	try {
		parsed = ext === ".yaml" || ext === ".yml" ? yaml.load(raw) : JSON.parse(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid suite manifest '${resolved}': ${detail}`);
	}

	const result = SuiteManifestSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`)
			.join("\n");
		throw new Error(`Suite manifest validation failed for '${resolved}':\n${issues}`);
	}

	return result.data;
}

interface SuiteRunCommandOptions {
	workspace?: string;
	concurrency?: string;
	headless?: boolean;
	outputDir?: string;
	dryRun?: boolean;
}

async function suiteRunCommand(manifestArg: string, options: SuiteRunCommandOptions): Promise<void> {
	const manifestPath = path.resolve(process.cwd(), manifestArg);
	const manifest = await loadManifest(manifestPath);

	// Resolve workspace: CLI flag > manifest field > workspace default
	const workspaceBase = options.workspace ?? manifest.workspace;
	const config = loadScenarioConfig({ workspace: workspaceBase });
	const workspace = config.workspace;

	// Resolve output dir: CLI flag > manifest field > workspace outputDir
	const outputBase = options.outputDir
		? path.resolve(process.cwd(), options.outputDir)
		: manifest.outputDir
			? path.resolve(path.dirname(manifestPath), manifest.outputDir)
			: config.outputDir;

	// Resolve concurrency
	const concurrency = options.concurrency !== undefined
		? parseInt(options.concurrency, 10)
		: (manifest.concurrency ?? 3);

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error(`--concurrency must be a positive integer, got '${options.concurrency ?? ""}'.`);
	}

	// Resolve headless: CLI flag > manifest field > false
	const headless = options.headless === true ? true : (manifest.headless ?? false);

	// Build effective manifest with resolved overrides
	const effectiveManifest: SuiteManifest = { ...manifest, concurrency, headless };

	const suiteId = formatSuiteId();
	const suiteDir = path.join(outputBase, suiteId);

	const tasks = expandTasks(effectiveManifest, suiteDir);

	if (tasks.length === 0) {
		throw new Error("Suite manifest produced no tasks. Check your tasks/matrix definitions.");
	}

	if (options.dryRun) {
		process.stdout.write(`Suite: ${suiteId}\n`);
		process.stdout.write(`Workspace: ${workspace}\n`);
		process.stdout.write(`Output dir: ${suiteDir}\n`);
		process.stdout.write(`Concurrency: ${concurrency}\n`);
		process.stdout.write(`Headless: ${String(headless)}\n`);
		process.stdout.write(`\nTasks (${tasks.length}):\n`);
		for (const task of tasks) {
			const ctx = task.context.length > 0 ? `[${task.context.join(", ")}]` : "(no context)";
			process.stdout.write(`  ${String(task.index + 1).padStart(3)}. ${task.label}  ${task.scenario}  ${ctx}\n`);
		}
		return;
	}

	process.stdout.write(`Starting suite ${suiteId}\n`);
	process.stdout.write(`Workspace: ${workspace}\n`);
	process.stdout.write(`Tasks: ${tasks.length}  Concurrency: ${concurrency}  Headless: ${String(headless)}\n\n`);

	const suiteResult = await runSuite(effectiveManifest, manifestPath, suiteDir, {
		workspace,
		headless,
		onTaskStart: (task: ExpandedTask) => {
			const ctx = task.context.length > 0 ? ` [${task.context.join(", ")}]` : "";
			process.stdout.write(`  [${task.label}] starting${ctx}...\n`);
		},
		onTaskComplete: (result: TaskResult) => {
			const label = statusLabel(result);
			const duration = formatDuration(result.durationMs);
			const extra = result.errorMessage ? ` — ${result.errorMessage.split("\n")[0] ?? ""}` : "";
			process.stdout.write(`  [${result.label}] ${label} (${duration})${extra}\n`);
		},
	});

	// Write HTML and markdown reports
	const htmlPath = path.join(suiteDir, "suite-summary.html");
	const mdPath = path.join(suiteDir, "suite-summary.md");
	await writeFile(htmlPath, renderSuiteReportHtml(suiteResult) + "\n", "utf8");
	await writeFile(mdPath, renderSuiteReportMarkdown(suiteResult) + "\n", "utf8");

	process.stdout.write(`\nSuite complete: ${suiteResult.passed}/${suiteResult.total} passed`);
	if (suiteResult.failed > 0) process.stdout.write(`, ${suiteResult.failed} failed`);
	if (suiteResult.errored > 0) process.stdout.write(`, ${suiteResult.errored} errored`);
	process.stdout.write(`\nReport: ${htmlPath}\n`);

	if (suiteResult.passed < suiteResult.total) {
		process.exitCode = 1;
	}
}

export default function registerSuiteCommands(program: Command): void {
	const suite = program.command("suite").description("Manage and run test suites");

	suite
		.command("run <manifest>")
		.description("Run a suite of scenarios defined in a manifest file (JSON or YAML)")
		.option("--workspace <path>", "Workspace directory override")
		.option("--concurrency <n>", "Maximum number of parallel tasks (default: 3)")
		.option("--headless", "Force headless browser mode for all tasks")
		.option("--output-dir <path>", "Directory for suite report output")
		.option("--dry-run", "Print tasks that would run without executing them")
		.action(async (manifestArg: string, opts: SuiteRunCommandOptions) => {
			await suiteRunCommand(manifestArg, opts);
		});
}
