import { z } from "zod";
import {
  ReportGeneratorSchema,
  ScreenshotModeSchema,
  WorkspaceDefaultsPatchSchema,
  WorkspaceDefaultsSchema
} from "./schemas.js";

export const DEFAULT_WORKSPACE_DEFAULTS = {
  baseUrl: "http://localhost:8080",
  llm: "",
  persona: "",
  context: [],
  maxSteps: 40,
  settleDelayMs: 500,
  settleTimeoutMs: 3000,
  headless: false,
  screenshots: "none",
  reports: ["markdown", "html"],
  debug: false,
  outputDir: "./reports",
  observationConfigFile: ""
} as const;

const ResolvedWorkspaceConfigSchema = z.object({
  baseUrl: z.string().url(),
  llm: z.string(),
  persona: z.string(),
  context: z.array(z.string()),
  maxSteps: z.number().int().positive(),
  settleDelayMs: z.number().int().positive(),
  settleTimeoutMs: z.number().int().positive(),
  headless: z.boolean(),
  screenshots: ScreenshotModeSchema,
  reports: z.array(ReportGeneratorSchema),
  debug: z.boolean(),
  outputDir: z.string(),
  observationConfigFile: z.string()
});

export type ConfigValueSource = "cli" | "environment" | "workspace" | "built-in";
export type Environment = Readonly<Record<string, string | undefined>>;
export type ResolvedWorkspaceConfig = z.infer<typeof ResolvedWorkspaceConfigSchema>;

export interface ResolveWorkspaceConfigInput {
  cli?: unknown;
  environment?: Environment;
  workspace?: unknown;
}

export interface ResolvedWorkspaceConfigResult {
  values: ResolvedWorkspaceConfig;
  sources: Record<keyof ResolvedWorkspaceConfig, ConfigValueSource>;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;

  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [];
}

function parseReports(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "none") return [];
  return parseList(value);
}

function parseEnvironment(environment: Environment) {
  return WorkspaceDefaultsPatchSchema.parse({
    baseUrl: environment.DUBLO_BASE_URL,
    llm: environment.DUBLO_LLM,
    persona: environment.DUBLO_PERSONA,
    context: parseList(environment.DUBLO_CONTEXT),
    maxSteps: parsePositiveInteger(environment.DUBLO_MAX_STEPS),
    settleDelayMs: parsePositiveInteger(environment.DUBLO_SETTLE_DELAY_MS),
    settleTimeoutMs: parsePositiveInteger(environment.DUBLO_SETTLE_TIMEOUT_MS),
    headless: parseBoolean(environment.DUBLO_HEADLESS),
    screenshots: environment.DUBLO_SCREENSHOTS,
    reports: parseReports(environment.DUBLO_REPORTS),
    debug: parseBoolean(environment.DUBLO_DEBUG),
    outputDir: environment.DUBLO_OUTPUT_DIR,
    observationConfigFile: environment.DUBLO_OBSERVATION_CONFIG_FILE
  });
}

function resolveValue<T>(
  cli: T | undefined,
  environment: T | undefined,
  workspace: T | undefined,
  fallback: T
): readonly [T, ConfigValueSource] {
  if (cli !== undefined) return [cli, "cli"];
  if (environment !== undefined) return [environment, "environment"];
  if (workspace !== undefined) return [workspace, "workspace"];
  return [fallback, "built-in"];
}

export function resolveWorkspaceConfig(
  input: ResolveWorkspaceConfigInput = {}
): ResolvedWorkspaceConfigResult {
  const cli = WorkspaceDefaultsPatchSchema.parse(input.cli ?? {});
  const environment = parseEnvironment(input.environment ?? {});
  const workspace = WorkspaceDefaultsSchema.parse(input.workspace ?? {});

  const [baseUrl, baseUrlSource] = resolveValue(
    cli.baseUrl,
    environment.baseUrl,
    workspace.baseUrl,
    DEFAULT_WORKSPACE_DEFAULTS.baseUrl
  );
  const [llm, llmSource] = resolveValue(cli.llm, environment.llm, workspace.llm, DEFAULT_WORKSPACE_DEFAULTS.llm);
  const [persona, personaSource] = resolveValue(
    cli.persona,
    environment.persona,
    workspace.persona,
    DEFAULT_WORKSPACE_DEFAULTS.persona
  );
  const [context, contextSource] = resolveValue(
    cli.context,
    environment.context,
    workspace.context,
    [...DEFAULT_WORKSPACE_DEFAULTS.context]
  );
  const [maxSteps, maxStepsSource] = resolveValue(
    cli.maxSteps,
    environment.maxSteps,
    workspace.maxSteps,
    DEFAULT_WORKSPACE_DEFAULTS.maxSteps
  );
  const [settleDelayMs, settleDelayMsSource] = resolveValue(
    cli.settleDelayMs,
    environment.settleDelayMs,
    workspace.settleDelayMs,
    DEFAULT_WORKSPACE_DEFAULTS.settleDelayMs
  );
  const [settleTimeoutMs, settleTimeoutMsSource] = resolveValue(
    cli.settleTimeoutMs,
    environment.settleTimeoutMs,
    workspace.settleTimeoutMs,
    DEFAULT_WORKSPACE_DEFAULTS.settleTimeoutMs
  );
  const [headless, headlessSource] = resolveValue(
    cli.headless,
    environment.headless,
    workspace.headless,
    DEFAULT_WORKSPACE_DEFAULTS.headless
  );
  const [screenshots, screenshotsSource] = resolveValue(
    cli.screenshots,
    environment.screenshots,
    workspace.screenshots,
    DEFAULT_WORKSPACE_DEFAULTS.screenshots
  );
  const [reports, reportsSource] = resolveValue(
    cli.reports,
    environment.reports,
    workspace.reports,
    [...DEFAULT_WORKSPACE_DEFAULTS.reports]
  );
  const [debug, debugSource] = resolveValue(
    cli.debug,
    environment.debug,
    workspace.debug,
    DEFAULT_WORKSPACE_DEFAULTS.debug
  );
  const [outputDir, outputDirSource] = resolveValue(
    cli.outputDir,
    environment.outputDir,
    workspace.outputDir,
    DEFAULT_WORKSPACE_DEFAULTS.outputDir
  );
  const [observationConfigFile, observationConfigFileSource] = resolveValue(
    cli.observationConfigFile,
    environment.observationConfigFile,
    workspace.observationConfigFile,
    DEFAULT_WORKSPACE_DEFAULTS.observationConfigFile
  );

  return {
    values: ResolvedWorkspaceConfigSchema.parse({
      baseUrl,
      llm,
      persona,
      context,
      maxSteps,
      settleDelayMs,
      settleTimeoutMs,
      headless,
      screenshots,
      reports,
      debug,
      outputDir,
      observationConfigFile
    }),
    sources: {
      baseUrl: baseUrlSource,
      llm: llmSource,
      persona: personaSource,
      context: contextSource,
      maxSteps: maxStepsSource,
      settleDelayMs: settleDelayMsSource,
      settleTimeoutMs: settleTimeoutMsSource,
      headless: headlessSource,
      screenshots: screenshotsSource,
      reports: reportsSource,
      debug: debugSource,
      outputDir: outputDirSource,
      observationConfigFile: observationConfigFileSource
    }
  };
}