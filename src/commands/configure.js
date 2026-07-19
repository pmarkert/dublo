import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const DEFAULT_CONFIG = {
  baseUrl: "http://localhost:8080",
  llm: "default",
  persona: "",
  context: [],
  maxSteps: 40,
  headless: false,
  artifactScreenshotMode: "none",
  debug: false,
  outputDir: "./output/runs"
};

const DEFAULT_WORKSPACE_PROMPT = `# Application Notes

Use this file to capture background knowledge, application quirks, test account notes, special commands, and workspace-specific testing instructions for Dublo.
`;

export async function configureCommand(options = {}) {
  const workspaceInput = firstDefined(
    options.workspace,
    process.env.DUBLO_WORKSPACE,
    "./.dublo"
  );
  const workspacePath = path.resolve(process.cwd(), workspaceInput);
  const configPath = path.join(workspacePath, "config.json");
  const workspacePromptPath = path.join(workspacePath, "prompt.md");

  if (options.showPrompt) {
    await showWorkspacePrompt(workspacePromptPath);
    return;
  }

  if (options.prompt) {
    await editWorkspacePrompt(workspacePath, workspacePromptPath, options);
    return;
  }

  const existingConfig = await readExistingConfig(configPath);
  const seed = {
    ...DEFAULT_CONFIG,
    ...existingConfig,
    headless: resolveHeadlessSeed(existingConfig),
    context: normalizeContext(existingConfig.context)
  };

  if (options.yes) {
    const nextConfig = cleanUndefined({
      baseUrl: seed.baseUrl,
      llm: seed.llm,
      persona: seed.persona,
      ...(seed.context.length > 0 ? { context: seed.context } : {}),
      maxSteps: seed.maxSteps,
      headless: seed.headless,
      artifactScreenshotMode: normalizeScreenshotMode(seed.artifactScreenshotMode),
      debug: seed.debug,
      outputDir: seed.outputDir
    });

    await mkdir(workspacePath, { recursive: true });
    await Promise.all([
      mkdir(path.join(workspacePath, "llm"), { recursive: true }),
      mkdir(path.join(workspacePath, "personas"), { recursive: true }),
      mkdir(path.join(workspacePath, "scenarios"), { recursive: true }),
      mkdir(path.join(workspacePath, "context"), { recursive: true })
    ]);
    await ensureWorkspaceGitignore(workspacePath, nextConfig.outputDir);
    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

    process.stdout.write(`Wrote ${configPath}\n`);
    process.stdout.write(`Initialized workspace folders under ${workspacePath}\n`);
    process.stdout.write(`Updated ${path.join(workspacePath, ".gitignore")}\n`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(`\nDublo workspace configuration\n`);
    process.stdout.write(`Workspace: ${workspacePath}\n`);
    process.stdout.write(`Config: ${configPath}\n\n`);

    const baseUrl = await askText(rl, "Base URL", seed.baseUrl);
    const llm = await askOptionalText(rl, "Default llm profile/name (blank to unset)", seed.llm);
    const persona = await askOptionalText(rl, "Default persona profile/name (blank to unset)", seed.persona);

    const contextDefault = seed.context.join(",");
    const contextCsv = await askOptionalText(
      rl,
      "Default context profiles/files (comma separated, blank to unset)",
      contextDefault
    );
    const context = normalizeContext(contextCsv);

    const maxSteps = await askNumber(rl, "Max steps", seed.maxSteps);
    const headless = await askBoolean(rl, "Headless browser", seed.headless);
    const artifactScreenshotMode = await askChoice(
      rl,
      "Artifact screenshot mode",
      ["none", "viewport", "fullpage"],
      normalizeScreenshotMode(seed.artifactScreenshotMode)
    );
    const debug = await askBoolean(rl, "Debug logging", seed.debug);
    const outputDir = await askText(rl, "Output directory", seed.outputDir);

    const createStructure = await askBoolean(
      rl,
      "Create workspace folders (llm, personas, scenarios, context)",
      true
    );

    const nextConfig = cleanUndefined({
      baseUrl,
      llm,
      persona,
      ...(context.length > 0 ? { context } : {}),
      maxSteps,
      headless,
      artifactScreenshotMode,
      debug,
      outputDir
    });

    process.stdout.write("\nAbout to write config.json:\n");
    process.stdout.write(`${JSON.stringify(nextConfig, null, 2)}\n\n`);

    const confirm = await askBoolean(rl, "Write this config", true);
    if (!confirm) {
      process.stdout.write("Canceled. No files were changed.\n");
      return;
    }

    await mkdir(workspacePath, { recursive: true });
    if (createStructure) {
      await Promise.all([
        mkdir(path.join(workspacePath, "llm"), { recursive: true }),
        mkdir(path.join(workspacePath, "personas"), { recursive: true }),
        mkdir(path.join(workspacePath, "scenarios"), { recursive: true }),
        mkdir(path.join(workspacePath, "context"), { recursive: true })
      ]);
      await ensureWorkspaceGitignore(workspacePath, nextConfig.outputDir);
    }

    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

    process.stdout.write(`\nWrote ${configPath}\n`);
    if (createStructure) {
      process.stdout.write(`Initialized workspace folders under ${workspacePath}\n`);
      process.stdout.write(`Updated ${path.join(workspacePath, ".gitignore")}\n`);
    }
  } finally {
    rl.close();
  }
}

async function ensureWorkspaceGitignore(workspacePath, outputDir) {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  const outputIgnoreEntry = deriveOutputIgnoreEntry(outputDir);

  let content = "";
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.includes(outputIgnoreEntry)) {
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const nextContent = `${content}${separator}${outputIgnoreEntry}\n`;
    await writeFile(gitignorePath, nextContent, "utf8");
  }
}

function deriveOutputIgnoreEntry(outputDir) {
  const rawValue = String(outputDir || "").trim();
  const fallback = "output/";
  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../")) {
    return fallback;
  }

  const [firstSegment] = normalized.split("/").filter(Boolean);
  if (!firstSegment || firstSegment === "." || firstSegment === "..") {
    return fallback;
  }

  return `${firstSegment}/`;
}

async function showWorkspacePrompt(workspacePromptPath) {
  if (!existsSync(workspacePromptPath)) {
    throw new Error(`Workspace prompt file does not exist: ${workspacePromptPath}`);
  }

  const content = await readFile(workspacePromptPath, "utf8");
  process.stdout.write(content);
  if (!content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function editWorkspacePrompt(workspacePath, workspacePromptPath, options) {
  await mkdir(workspacePath, { recursive: true });

  if (!process.stdin.isTTY) {
    let body = "";
    for await (const chunk of process.stdin) {
      body += String(chunk);
    }
    await writeFile(workspacePromptPath, body, "utf8");
    process.stdout.write(`Wrote ${workspacePromptPath}\n`);
    return;
  }

  if (options.yes) {
    if (!existsSync(workspacePromptPath)) {
      await writeFile(workspacePromptPath, DEFAULT_WORKSPACE_PROMPT, "utf8");
    }
    process.stdout.write(`Prepared ${workspacePromptPath}\n`);
    return;
  }

  if (!existsSync(workspacePromptPath)) {
    await writeFile(workspacePromptPath, DEFAULT_WORKSPACE_PROMPT, "utf8");
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = spawnSync(editor, [workspacePromptPath], {
    stdio: "inherit",
    shell: true
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}

async function readExistingConfig(configPath) {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = await readFile(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in existing config '${configPath}': ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing config '${configPath}' must contain a JSON object.`);
  }

  return parsed;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== ""));
}

function normalizeContext(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeScreenshotMode(value) {
  const normalized = String(value || "none").toLowerCase().trim();
  if (["none", "viewport", "fullpage"].includes(normalized)) {
    return normalized;
  }
  return "none";
}

function resolveHeadlessSeed(existingConfig) {
  if (typeof existingConfig.headless === "boolean") {
    return existingConfig.headless;
  }

  if (typeof existingConfig.headed === "boolean") {
    return !existingConfig.headed;
  }

  return DEFAULT_CONFIG.headless;
}

async function askText(rl, label, defaultValue) {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  const trimmed = answer.trim();
  if (!trimmed && defaultValue !== undefined) {
    return String(defaultValue);
  }
  return trimmed;
}

async function askOptionalText(rl, label, defaultValue) {
  const answer = await askText(rl, label, defaultValue || "");
  return answer.trim();
}

async function askBoolean(rl, label, defaultValue) {
  const promptDefault = defaultValue ? "Y/n" : "y/N";

  while (true) {
    const answer = await rl.question(`${label} (${promptDefault}): `);
    const trimmed = answer.trim().toLowerCase();

    if (!trimmed) {
      return Boolean(defaultValue);
    }

    if (["y", "yes", "true", "1"].includes(trimmed)) {
      return true;
    }

    if (["n", "no", "false", "0"].includes(trimmed)) {
      return false;
    }

    process.stdout.write("Please answer yes or no.\n");
  }
}

async function askNumber(rl, label, defaultValue) {
  while (true) {
    const raw = await askText(rl, label, String(defaultValue));
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    process.stdout.write("Please enter a positive number.\n");
  }
}

async function askChoice(rl, label, options, defaultValue) {
  const normalizedDefault = options.includes(defaultValue) ? defaultValue : options[0];

  while (true) {
    const answer = await askText(rl, `${label} (${options.join("/")})`, normalizedDefault);
    const normalized = String(answer || "").toLowerCase().trim();
    if (options.includes(normalized)) {
      return normalized;
    }

    process.stdout.write(`Please choose one of: ${options.join(", ")}\n`);
  }
}
