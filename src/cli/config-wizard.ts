import { checkbox, confirm, input, number, select } from "@inquirer/prompts";
import { DEFAULT_WORKSPACE_DEFAULTS, resolveWorkspaceConfig } from "../core/config/resolve.js";
import { ReportGeneratorSchema, ScreenshotModeSchema } from "../core/config/schemas.js";
import type { ReportGenerator, WorkspaceDefaults } from "../core/config/schemas.js";

interface TextPromptOptions {
  message: string;
  default: string;
  validate?: (value: string) => boolean | string;
}

interface NumberPromptOptions {
  message: string;
  default: number;
  min: number;
}

interface ConfirmPromptOptions {
  message: string;
  default: boolean;
}

export interface PromptChoice<Value> {
  name: string;
  value: Value;
  description?: string;
  checked?: boolean;
}

interface SelectPromptOptions<Value> {
  message: string;
  choices: readonly PromptChoice<Value>[];
  default: Value;
}

interface CheckboxPromptOptions<Value> {
  message: string;
  choices: readonly PromptChoice<Value>[];
}

export interface ConfigWizardPrompts {
  input(options: TextPromptOptions): Promise<string>;
  number(options: NumberPromptOptions): Promise<number>;
  confirm(options: ConfirmPromptOptions): Promise<boolean>;
  select<Value>(options: SelectPromptOptions<Value>): Promise<Value>;
  checkbox<Value>(options: CheckboxPromptOptions<Value>): Promise<Value[]>;
}

export interface ConfigWizardOptions {
  current: WorkspaceDefaults;
  profiles: {
    llm: readonly PromptChoice<string>[];
    persona: readonly PromptChoice<string>[];
    context: readonly PromptChoice<string>[];
  };
  prompts: ConfigWizardPrompts;
  write: (text: string) => void;
}

export function createInquirerConfigPrompts(): ConfigWizardPrompts {
  return {
    input,
    number: (options) => number({ ...options, required: true }),
    confirm,
    select,
    checkbox
  };
}

export async function runConfigWizard(
  options: ConfigWizardOptions
): Promise<WorkspaceDefaults | undefined> {
  const values = resolveWorkspaceConfig({ workspace: options.current }).values;
  options.write("\nDublo workspace configuration\n");
  options.write(
    "Use the displayed defaults, arrow keys, and space to choose workspace behavior.\n\n"
  );

  const baseUrl = await options.prompts.input({
    message: "Base URL",
    default: values.baseUrl,
    validate: validateUrl
  });
  const llm =
    options.profiles.llm.length > 0
      ? await options.prompts.select({
          message: "Default LLM profile",
          choices: options.profiles.llm,
          default: selectedValue(values.llm, options.profiles.llm)
        })
      : values.llm;
  const persona = await options.prompts.select({
    message: "Default persona",
    choices: options.profiles.persona,
    default: selectedValue(values.persona, options.profiles.persona)
  });
  const context =
    options.profiles.context.length > 0
      ? await options.prompts.checkbox({
          message: "Default context profiles",
          choices: options.profiles.context.map((choice) => ({
            ...choice,
            checked: values.context.includes(choice.value)
          }))
        })
      : values.context;
  const maxSteps = await options.prompts.number({
    message: "Maximum steps",
    default: values.maxSteps,
    min: 1
  });
  const headless = await options.prompts.confirm({
    message: "Run browsers headlessly",
    default: values.headless
  });
  const screenshots = await options.prompts.select({
    message: "Screenshots",
    default: values.screenshots,
    choices: ScreenshotModeSchema.options.map((value) => ({
      name: screenshotLabel(value),
      value
    }))
  });
  const reports = await options.prompts.checkbox({
    message: "Report renderers",
    choices: ReportGeneratorSchema.options.map((value) => ({
      name: reportLabel(value),
      value,
      checked: values.reports.includes(value)
    }))
  });
  const debug = await options.prompts.confirm({
    message: "Enable debug logging",
    default: values.debug
  });
  const outputDir = await options.prompts.input({
    message: "Output directory",
    default: values.outputDir
  });
  const observationConfigFile = await options.prompts.input({
    message: "Observation configuration file",
    default: values.observationConfigFile
  });

  const next = omitBuiltInDefaults({
    baseUrl,
    llm,
    persona,
    context,
    maxSteps,
    settleDelayMs: values.settleDelayMs,
    settleTimeoutMs: values.settleTimeoutMs,
    headless,
    screenshots,
    reports,
    debug,
    outputDir,
    observationConfigFile
  });

  options.write("\nWorkspace defaults to save:\n");
  options.write(`${JSON.stringify(next, null, 2)}\n\n`);
  return (await options.prompts.confirm({
    message: "Save these workspace defaults",
    default: true
  }))
    ? next
    : undefined;
}

function selectedValue(value: string, choices: readonly PromptChoice<string>[]): string {
  return choices.some((choice) => choice.value === value) ? value : "";
}

function validateUrl(value: string): boolean | string {
  try {
    new URL(value);
    return true;
  } catch {
    return "Enter an absolute URL, for example https://example.test.";
  }
}

function screenshotLabel(value: (typeof ScreenshotModeSchema.options)[number]): string {
  switch (value) {
    case "none":
      return "No screenshots";
    case "viewport":
      return "Viewport screenshots";
    case "fullpage":
      return "Full-page screenshots";
  }
}

function reportLabel(value: ReportGenerator): string {
  return value === "html" ? "HTML" : "Markdown";
}

function omitBuiltInDefaults(values: Required<WorkspaceDefaults>): WorkspaceDefaults {
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => {
      const defaultValue =
        DEFAULT_WORKSPACE_DEFAULTS[key as keyof typeof DEFAULT_WORKSPACE_DEFAULTS];
      return JSON.stringify(value) !== JSON.stringify(defaultValue);
    })
  );
}
