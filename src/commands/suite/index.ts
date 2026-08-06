import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as yaml from "js-yaml";
import type { Command } from "commander";
import { resolveContextProfilePath } from "../context/shared.js";
import { resolveScenarioProfilePath } from "../scenario/shared.js";
import { runEditor } from "../../utils/editor.js";
import { loadScenarioConfig } from "../../utils/loadScenarioConfig.js";
import { openInDefaultViewer } from "../../utils/open-file.js";
import {
	SuiteManifestSchema,
	createSuiteRunReport,
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

export function formatSuiteId(manifestPath: string, startedAt = new Date()): string {
	const runDateTime = startedAt.toISOString().replace(/[.:]/g, "-");
	return `${runDateTime}_suite_${suiteName(path.basename(manifestPath))}`;
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
	if (result.status === "skipped") return "SKIPPED";
	return "ERROR";
}

function resolveWorkspacePath(workspace?: string): string {
	return path.resolve(process.cwd(), workspace || process.env.DUBLO_WORKSPACE || ".dublo");
}

function isSuiteManifestFile(name: string): boolean {
	return /\.(json|yaml|yml)$/i.test(name);
}

function suiteName(value: string): string {
	const normalized = value
		.trim()
		.replace(/\.(json|yaml|yml)$/i, "")
		.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!normalized) {
		throw new Error("Suite name cannot be empty.");
	}
	return normalized;
}

export function initialSuiteManifestContent(): string {
	return [
		"# A suite runs one or more saved scenario profiles.",
		"# Optional suite-wide settings:",
		"# workspace: ./.dublo",
		"# concurrency: 3",
		"# headless: true",
		"# outputDir: ./suite-reports",
		"# llm: default",
		"# persona: qa-strict",
		"",
		"# Define individual tasks. Each task can override the suite-wide LLM and persona.",
		"tasks:",
		"  - scenario: homepage-smoke",
		"    # context: qa-user",
		"    # id: setup",
		"    # label: homepage smoke",
		"    # dependsOn: [setup] # requires setup to pass",
		"    # dependsOn:",
		"    #   - task: cleanup",
		"    #     status: [success, fail]",
		"    # llm: default",
		"    # persona: qa-strict",
		"",
		"# Or replace tasks above with a matrix to run every scenario with every context.",
		"# matrix:",
		"#   scenarios:",
		"#     - homepage-smoke",
		"#     - checkout-happy-path",
		"#   contexts:",
		"#     - qa-user",
		"#     - [qa-user, tenant-a]",
		""
	].join("\n");
}

function resolveSuiteManifestPath(value: string, workspace?: string): string {
	const direct = path.resolve(process.cwd(), value);
	if (existsSync(direct)) {
		return direct;
	}

	const suiteDirectory = path.join(resolveWorkspacePath(workspace), "suites");
	const name = suiteName(value);
	for (const candidate of [
		path.join(suiteDirectory, value),
		path.join(suiteDirectory, `${name}.yaml`),
		path.join(suiteDirectory, `${name}.yml`),
		path.join(suiteDirectory, `${name}.json`),
	]) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return "";
}

function listSuiteNames(workspace?: string): string[] {
	const suiteDirectory = path.join(resolveWorkspacePath(workspace), "suites");
	try {
		return readdirSync(suiteDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isSuiteManifestFile(entry.name))
			.map((entry) => entry.name.replace(/\.(json|yaml|yml)$/i, ""))
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
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

interface SuiteOpenCommandOptions {
	workspace?: string;
	markdown?: boolean;
	json?: boolean;
}

async function suiteRunCommand(manifestArg: string, options: SuiteRunCommandOptions): Promise<void> {
	const manifestPath = resolveSuiteManifestPath(manifestArg, options.workspace);
	if (!manifestPath) {
		throw new Error(`Could not resolve suite manifest '${manifestArg}'.`);
	}
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

	const suiteId = formatSuiteId(manifestPath);
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

	const htmlPath = path.join(suiteDir, "summary.html");
	const mdPath = path.join(suiteDir, "summary.md");
	await writeFile(htmlPath, renderSuiteReportHtml(suiteResult) + "\n", "utf8");
	await writeFile(mdPath, renderSuiteReportMarkdown(suiteResult) + "\n", "utf8");

	const suiteReport = createSuiteRunReport(suiteResult);
	const reportPath = path.join(suiteDir, "report.json");
	await writeFile(reportPath, JSON.stringify(suiteReport, null, 2) + "\n", "utf8");
	await writeFile(
		path.join(outputBase, "latest.json"),
		JSON.stringify(
			{
				runId: suiteResult.suiteId,
				status: suiteReport.status,
				finalUrl: suiteReport.finalUrl,
				startedAt: suiteResult.startedAt,
				finishedAt: suiteResult.finishedAt,
				artifactsDir: suiteDir,
				reportPath,
				summaryPath: mdPath,
				summaryHtmlPath: htmlPath,
				reportType: "suite",
			},
			null,
			2
		) + "\n",
		"utf8"
	);

	process.stdout.write(`\nSuite complete: ${suiteResult.passed}/${suiteResult.total} passed`);
	if (suiteResult.failed > 0) process.stdout.write(`, ${suiteResult.failed} failed`);
	if (suiteResult.errored > 0) process.stdout.write(`, ${suiteResult.errored} errored`);
	if (suiteResult.skipped > 0) process.stdout.write(`, ${suiteResult.skipped} skipped`);
	process.stdout.write(`\nReport: ${htmlPath}\n`);

	if (suiteResult.failed > 0 || suiteResult.errored > 0) {
		process.exitCode = 1;
	}
}

async function suiteListCommand(options: { workspace?: string }): Promise<void> {
	const workspace = resolveWorkspacePath(options.workspace);
	const suiteDirectory = path.join(workspace, "suites");
	const names = listSuiteNames(options.workspace);
	if (names.length === 0) {
		process.stdout.write(`No suites found under ${suiteDirectory}.\n`);
		return;
	}

	process.stdout.write(`Suites in ${suiteDirectory}:\n`);
	for (const name of names) {
		process.stdout.write(`- ${name}\n`);
	}
}

export function resolveSuiteArtifactPath(
	suiteId: string | undefined,
	options: { workspace?: string; markdown?: boolean; json?: boolean } = {}
): string {
	if (options.markdown && options.json) {
		throw new Error("Use either --markdown or --json, not both.");
	}

	const config = loadScenarioConfig({ workspace: options.workspace });
	const outputDir = config.outputDir;
	let suiteDir = "";
	if (suiteId) {
		const directSuiteDir = path.resolve(process.cwd(), suiteId);
		if (existsSync(path.join(directSuiteDir, "suite.json"))) {
			suiteDir = directSuiteDir;
		} else {
			const outputSuiteDir = path.join(outputDir, suiteId);
			if (existsSync(path.join(outputSuiteDir, "suite.json"))) {
				suiteDir = outputSuiteDir;
			}
		}
		if (!suiteDir) {
			throw new Error(`Could not find suite '${suiteId}' under ${outputDir}.`);
		}
	} else {
		try {
			suiteDir = readdirSync(outputDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name.includes("_suite_"))
				.map((entry) => entry.name)
				.filter((entry) => existsSync(path.join(outputDir, entry, "suite.json")))
				.sort((left, right) => right.localeCompare(left))[0] ?? "";
		} catch {
			suiteDir = "";
		}
		if (!suiteDir) {
			throw new Error(`No suite reports found under ${outputDir}.`);
		}
		suiteDir = path.join(outputDir, suiteDir);
	}

	const artifactName = options.json
		? "suite.json"
		: options.markdown
			? "summary.md"
			: "summary.html";
	const artifactPath = path.join(suiteDir, artifactName);
	if (!existsSync(artifactPath)) {
		throw new Error(`Suite report artifact '${artifactName}' does not exist in ${suiteDir}.`);
	}
	return artifactPath;
}

async function suiteOpenCommand(suiteId: string | undefined, options: SuiteOpenCommandOptions): Promise<void> {
	const artifactPath = resolveSuiteArtifactPath(suiteId, options);
	await openInDefaultViewer(artifactPath);
	process.stdout.write(`${artifactPath}\n`);
}

async function suiteShowCommand(name: string, options: { workspace?: string }): Promise<void> {
	const manifestPath = resolveSuiteManifestPath(name, options.workspace);
	if (!manifestPath) {
		throw new Error(`Could not resolve suite manifest '${name}'.`);
	}
	const content = await readFile(manifestPath, "utf8");
	process.stdout.write(`File: ${manifestPath}\n--\n${content}`);
	if (!content.endsWith("\n")) {
		process.stdout.write("\n");
	}
}

async function suiteEditCommand(name: string, options: { workspace?: string }): Promise<void> {
	const workspace = resolveWorkspacePath(options.workspace);
	const suiteDirectory = path.join(workspace, "suites");
	await mkdir(suiteDirectory, { recursive: true });
	const manifestPath = resolveSuiteManifestPath(name, options.workspace) || path.join(suiteDirectory, `${suiteName(name)}.yaml`);

	if (!process.stdin.isTTY) {
		let content = "";
		for await (const chunk of process.stdin) {
			content += String(chunk);
		}
		await writeFile(manifestPath, content, "utf8");
		process.stdout.write(`Wrote ${manifestPath}\n`);
		return;
	}

	if (!existsSync(manifestPath)) {
		await writeFile(manifestPath, initialSuiteManifestContent(), "utf8");
	}
	const result = runEditor(process.env.VISUAL || process.env.EDITOR || "vi", manifestPath);
	if (result.error) {
		throw result.error;
	}
	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(`Editor exited with status ${result.status}.`);
	}
}

function validateManifestReferences(manifest: SuiteManifest, workspace: string): string[] {
	const errors: string[] = [];
	for (const task of expandTasks(manifest, "")) {
		if (!resolveScenarioProfilePath(workspace, task.scenario)) {
			errors.push(`task '${task.label}': scenario '${task.scenario}' could not be resolved`);
		}

		for (const context of task.context) {
			if (!resolveContextProfilePath(workspace, context)) {
				errors.push(`task '${task.label}': context '${context}' could not be resolved`);
			}
		}
	}
	return errors;
}

async function suiteValidateCommand(name: string | undefined, options: { workspace?: string }): Promise<void> {
	const targets = name ? [name] : listSuiteNames(options.workspace);
	if (targets.length === 0) {
		throw new Error("No suites found to validate.");
	}

	let hasErrors = false;
	for (const target of targets) {
		const manifestPath = resolveSuiteManifestPath(target, options.workspace);
		if (!manifestPath) {
			process.stdout.write(`FAIL ${target}: suite manifest could not be resolved\n`);
			hasErrors = true;
			continue;
		}
		try {
			const manifest = await loadManifest(manifestPath);
			const workspace = resolveWorkspacePath(options.workspace ?? manifest.workspace);
			const referenceErrors = validateManifestReferences(manifest, workspace);
			if (referenceErrors.length > 0) {
				throw new Error(referenceErrors.join("\n"));
			}
			process.stdout.write(`OK   ${target} (${manifestPath})\n`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			process.stdout.write(`FAIL ${target}: ${detail}\n`);
			hasErrors = true;
		}
	}

	if (hasErrors) {
		throw new Error("One or more suites are invalid.");
	}
}

export default function registerSuiteCommands(program: Command): void {
	const suite = program.command("suite").description("Manage and run test suites");

	suite
		.command("list")
		.description("List suite manifests in the workspace")
		.option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
		.action(async (options: { workspace?: string }) => {
			await suiteListCommand(options);
		});

	suite
		.command("show <suite>")
		.description("Print a suite manifest")
		.option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
		.action(async (name: string, options: { workspace?: string }) => {
			await suiteShowCommand(name, options);
		});

	suite
		.command("edit <suite>")
		.description("Write a suite manifest from stdin or open an interactive editor")
		.option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
		.action(async (name: string, options: { workspace?: string }) => {
			await suiteEditCommand(name, options);
		});

	suite
		.command("validate [suite]")
		.description("Validate one or all suite manifests")
		.option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
		.action(async (name: string | undefined, options: { workspace?: string }) => {
			await suiteValidateCommand(name, options);
		});

	suite
		.command("open [suite-id]")
		.description("Open a suite report, defaulting to the latest suite")
		.option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
		.option("--markdown", "Open the Markdown summary")
		.option("--json", "Open suite.json")
		.action(async (suiteId: string | undefined, options: SuiteOpenCommandOptions) => {
			await suiteOpenCommand(suiteId, options);
		});

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
