import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { generateReportArtifacts, rerenderReportArtifacts } from "../reporting/report-artifacts.mjs";
import { createBedrockPlanner } from "../node/bedrock-planner.js";
import { createOpenAICompatiblePlanner } from "../node/openai-compatible-planner.js";
import { createPlaywrightBrowserFactory } from "../node/playwright-browser.js";
import { createTerminalInteractionProvider } from "../node/terminal-interaction.js";
import { loadContextFromOperations, redactSecretValues, scrubSecretsFromText } from "./scenario/context-operations.mjs";
import { createRuntimeErrorTracker } from "./scenario/runtime-errors.mjs";
import { drawSetOfMarks, clearSetOfMarks } from "./scenario/set-of-marks.mjs";
import { buildPlannerMessages } from "./scenario/planner-context.mjs";
import { loadObservationConfig, normalizeScreenshotMode } from "./scenario/observation-config.mjs";
import { collectObservation } from "./scenario/observation.mjs";
import { addTokenUsageTotals, calculateCostEstimate, getConfiguredModelPricing } from "./scenario/pricing.mjs";
import {
  classifyRecoverableActionError,
  executeBrowserAction,
  formatExpectedDocumentText,
  isAlternatingScrollLoop,
  isDocumentTextGone,
  resolveTargetControl,
  waitForDocumentTextGone,
  waitForUiSettle,
} from "./scenario/action-executor.mjs";

export { classifyRecoverableActionError, isAlternatingScrollLoop, isDocumentTextGone, resolveTargetControl };

/**
 * Stable identity for "the planner tried this exact thing again".
 *
 * Only the action and its target matter -- a `fill` whose value differs but
 * whose target is identical is still the same doomed attempt when the target is
 * what cannot be resolved.
 */
/**
 * A coarse fingerprint of "what the user is looking at".
 *
 * Deliberately ignores which action was taken and whether it succeeded: the
 * question is only whether the run is getting anywhere. Uses the URL, the
 * visible document text, and the set of control ids -- enough to notice a
 * changed screen, stable enough that re-rendering the same screen does not
 * read as progress.
 */
/**
 * Paths a run must have visited before `finish` is believable.
 *
 * Read from context so it travels with the scenario rather than the workspace:
 * `finish.requireVisited` for an explicit list, or `finish.requireVisitedFrom`
 * naming a dotted path to a list already in context — so a route sweep can point
 * at the same inventory it was given to walk, instead of restating it.
 */
export function requiredVisitedPaths(contextData) {
  const finish = contextData?.finish;
  if (!finish || typeof finish !== "object") return [];

  if (Array.isArray(finish.requireVisited)) {
    return finish.requireVisited.filter((entry) => typeof entry === "string");
  }

  if (typeof finish.requireVisitedFrom === "string") {
    const resolved = finish.requireVisitedFrom
      .split(".")
      .reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), contextData);
    if (Array.isArray(resolved)) return resolved.filter((entry) => typeof entry === "string");
  }

  return [];
}

/**
 * Checks the world must satisfy before a run can mean anything.
 *
 * A precondition written only in the scenario prose is a request, not a check --
 * a run against an unprepared app produced 23 steps, a claim that "tasks
 * scheduled for today were accurately displayed" on an account that had none,
 * and a `blocked` verdict pointing at a defect that did not exist. Declared here
 * instead, the runner verifies them itself and refuses to start.
 *
 *   preconditions:
 *     - path: "/myday"
 *       documentTextIncludes: "Today"
 *       describe: "MyDay must show at least one task for today"
 */
export function preconditionsFrom(contextData) {
  const list = contextData?.preconditions;
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry === "object") : [];
}

/**
 * A scenario's expected step count: a baseline drawn from a known-good run, not
 * a ceiling.
 *
 * `maxSteps` says when to give up; this says what the work normally costs. A run
 * finishing well above it did the same job the long way round, which is a
 * regression in the path even though the run passed — the kind of drift nobody
 * notices because the test still goes green.
 */
export function expectedStepsFrom(contextData) {
  const value = contextData?.finish?.expectedSteps;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The pathname of a URL, for comparing against a declared path list. */
export function pathOf(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return String(url || "");
  }
}

/**
 * Recoverable failures on a passing run above which the path itself looks hard:
 * wrong controls tried, actions that did nothing, targets that would not resolve.
 * Absolute on purpose -- unlike a budget ratio, it means the same thing whatever
 * step ceiling the scenario happens to carry.
 */
const FRICTION_FAILURE_THRESHOLD = 5;

/**
 * How far above its expected step count a run may drift before it is worth
 * saying so. Compared against a baseline from a known-good run, so unlike a
 * budget ratio this reflects the path getting longer rather than the ceiling
 * being tight.
 */
const STEP_DRIFT_TOLERANCE = 0.3;

/**
 * Why a run ended, in terms a reader can act on.
 *
 * "failed" conflates four different answers: the app could not do it, the path
 * was too convoluted to follow, the budget was too small, or the agent jammed on
 * one control. Each points somewhere different -- a bug, a design problem, a
 * config change, or a tooling problem -- so the report should say which.
 */
export function classifyOutcome({ status, error, metCriteria, recoverableFailures, stepsUsed = 0, expectedSteps = 0 }) {
  if (status === "passed") {
    /*
     * Graded on friction, not on how much of the budget was spent.
     *
     * Steps-against-budget measures the budget, which is a guess: the same path
     * allotted 30 steps and finishing in 29 would score worse than one allotted
     * 50 and finishing in 34, for identical work. Recoverable failures are
     * intrinsic instead -- each one is the agent trying something that did not
     * work, which is friction a person would have felt too.
     */
    if (recoverableFailures >= FRICTION_FAILURE_THRESHOLD) return "completed-with-friction";
    if (expectedSteps > 0 && stepsUsed > expectedSteps * (1 + STEP_DRIFT_TOLERANCE)) {
      return "completed-slower-than-expected";
    }
    return "completed";
  }

  const detail = String(error || "");

  /*
   * Tooling failures first. A planner that returns nothing, or output Bedrock
   * rejects, says nothing about the app -- and falling through to "blocked"
   * would report a harness problem as a probable defect in the product, which
   * is the most expensive kind of wrong answer this classifier can give.
   */
  // Setup, before tooling: a run that never started says nothing about the app,
  // and must not be filed under any verdict that implies it did.
  if (/Precondition not met|Could not verify precondition/i.test(detail)) return "precondition-not-met";

  if (
    /returned no planner action|invalid sequence as part of ToolUse|preflight failed|invalid '[a-z_]+' turn/i.test(
      detail
    )
  ) {
    return "tooling-error";
  }

  if (/without meeting a new success criterion/i.test(detail)) return "lost";
  if (/no visible change/i.test(detail)) return "stuck";
  if (/failed \d+ times in a row/i.test(detail)) return "blocked";
  if (/Max steps reached/i.test(detail)) {
    // Still meeting criteria when the budget ran out means the budget was wrong,
    // not the app.
    return metCriteria > 0 ? "budget-exhausted" : "lost";
  }
  if (recoverableFailures > 0) return "blocked";
  return "failed";
}

export function progressKey(url, observation) {
  const text = typeof observation?.documentText === "string" ? observation.documentText : "";
  const ids = (observation?.controls ?? [])
    .map((control) => control?.id)
    .filter(Boolean)
    .join(",");
  return `${url}|${text.length}:${text.slice(0, 400)}|${ids}`;
}

export function actionSignature(plannerAction) {
  const payload = plannerAction?.payload ?? {};
  const target = payload.target ?? payload.containerId ?? payload.selector ?? null;
  return JSON.stringify([payload.action ?? "", target]);
}

/**
 * How many times the tail of `history` repeats `signature` with a failing
 * outcome. Counting only the tail is deliberate: an action that failed, then
 * succeeded, then failed again is not a stuck planner.
 */
export function trailingFailureRepeats(history, signature) {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.outcome === "ok") break;
    if (actionSignature(entry.action) !== signature) break;
    count += 1;
  }
  return count;
}


function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveRunLabel(config) {
  if (config.scenarioFile) {
    const fileName = path.basename(String(config.scenarioFile));
    const profileName = path.basename(fileName, path.extname(fileName));
    return sanitizeSegment(profileName || "scenario");
  }

  return "adhoc";
}

function formatRunDateTime(value) {
  return value.toISOString().replace(/[.:]/g, "-");
}

function resolveRunOutcome(status) {
  if (status === "passed") return "pass";
  if (status === "interrupted") return "abort";
  return "fail";
}

function createRunId(startedAt, outcome, label) {
  return `${formatRunDateTime(startedAt)}_${outcome}_${label}`;
}

function clip(value, limit = 180) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1)}...`;
}

export { rerenderReportArtifacts };

function createRunnerLogger(headed) {
  const emit = (level, message) => {
    if (headed) {
      return;
    }

    const timestamp = new Date().toISOString();
    process.stdout.write(`[agentic ${timestamp}] ${level.toUpperCase()}: ${message}\n`);
  };

  return {
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

function createDebugLogger(enabled) {
  const emit = (message) => {
    if (!enabled) {
      return;
    }

    const timestamp = new Date().toISOString();
    process.stdout.write(`[agentic-debug ${timestamp}] ${message}\n`);
  };

  return {
    log: emit,
  };
}

function stripAnsi(value) {
  return String(value || "").replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "");
}

function errorMessage(error) {
  return stripAnsi(error instanceof Error ? error.message : String(error));
}

const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "that", "with", "this", "from", "into", "your", "then", "than",
  "have", "will", "should", "must", "when", "where", "which", "while", "verify",
  "check", "ensure", "make", "sure", "click", "open", "page", "test", "user",
  "using", "able", "does", "onto", "over", "under", "each", "some", "them",
  "they", "there", "their", "about", "after", "before", "again",
]);

// Extracts distinctive lowercased words from the scenario to bias control
// ranking toward the objective. Deliberately simple: split on non-word
// characters, drop short/stop words, dedupe, and cap the list.
function deriveRelevanceKeywords(scenario) {
  const words = String(scenario || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !RELEVANCE_STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 24);
}

async function loadPersonaText(personaFile) {
  if (!personaFile) {
    return "Default persona: pragmatic user with average technical comfort, prefers obvious and intuitive UI paths.";
  }

  const resolved = path.resolve(process.cwd(), personaFile);
  const content = await readFile(resolved, "utf8");
  return content.trim();
}

async function loadWorkspacePromptText(workspacePromptFile) {
  if (!workspacePromptFile) {
    return "";
  }

  const resolved = path.resolve(process.cwd(), workspacePromptFile);
  const content = await readFile(resolved, "utf8");
  return content.trim();
}

async function resolveScenarioText(config) {
  if (config.scenario && config.scenario.trim()) {
    return config.scenario.trim();
  }

  if (config.scenarioFile) {
    const resolved = path.resolve(process.cwd(), config.scenarioFile);
    const content = await readFile(resolved, "utf8");
    const prompt = content.trim();
    if (!prompt) {
      throw new Error(`Scenario file '${resolved}' is empty.`);
    }
    return prompt;
  }

  throw new Error("Missing scenario. Provide --scenario or --scenario-file.");
}

async function requestPlannerAction({ planner, messages, screenshotBuffer, signal }) {
  return planner.nextAction({
    messages,
    ...(screenshotBuffer ? { screenshot: screenshotBuffer } : {}),
    ...(signal ? { signal } : {}),
  });
}

function describeTarget(target) {
  return target ? JSON.stringify(target) : "none";
}

export async function runScenario(config, options = {}) {
  const startedAt = new Date();
  const shouldInterrupt = typeof options.shouldInterrupt === "function" ? options.shouldInterrupt : () => false;
  let browserClosed = false;

  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) {
    throw new Error("--max-steps must be a positive number");
  }
  if (!Number.isInteger(config.settleDelayMs) || config.settleDelayMs < 1) {
    throw new Error("--settle-delay-ms must be a positive integer");
  }
  if (!Number.isInteger(config.settleTimeoutMs) || config.settleTimeoutMs < config.settleDelayMs) {
    throw new Error("--settle-timeout-ms must be a positive integer greater than or equal to --settle-delay-ms");
  }

  const throwIfInterrupted = () => {
    if (shouldInterrupt() || browserClosed) {
      throw createInterruptError(browserClosed ? "Browser was closed." : "Interrupted by Ctrl-C.");
    }
  };

  const { contextData, secretValues } = await loadContextFromOperations(config.contextOperations);
  const personaText = await loadPersonaText(config.personaFile);
  const workspacePromptText = await loadWorkspacePromptText(config.workspacePromptFile);
  const scenario = await resolveScenarioText(config);
  const observationConfig = await loadObservationConfig(config.observationConfigFile);
  // Seed relevance keywords from the scenario so control ranking favors controls
  // related to the objective. An explicit config value takes precedence.
  if (!Array.isArray(observationConfig.relevanceKeywords) || observationConfig.relevanceKeywords.length === 0) {
    observationConfig.relevanceKeywords = deriveRelevanceKeywords(scenario);
  }
  const screenshots = normalizeScreenshotMode(config.screenshots);

  const runLabel = resolveRunLabel(config);
  let runId = createRunId(startedAt, "pending", runLabel);
  let runDir = path.join(config.outputDir, runId);
  const screenshotsDir = path.join(runDir, "screenshots");

  await mkdir(screenshotsDir, { recursive: true });

  const report = {
    runId,
    objective: scenario,
    config: {
      baseUrl: config.baseUrl,
      headed: config.headed,
      debug: config.debug,
      llm: config.llm,
      maxSteps: config.maxSteps,
      settleDelayMs: config.settleDelayMs,
      settleTimeoutMs: config.settleTimeoutMs,
      contextOperations: config.contextOperations,
      workspacePromptFile: config.workspacePromptFile,
      personaFile: config.personaFile,
      scenarioFile: config.scenarioFile,
      observationConfigFile: config.observationConfigFile,
      screenshots,
      reports: Array.isArray(config.reports) ? config.reports : [],
      initBlocks: Array.isArray(config.initBlocks) ? config.initBlocks.map((block) => block.name) : [],
    },
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    status: "running",
    finalUrl: "",
    tokenUsage: {
      provider: config.llm.provider,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      plannerCalls: 0,
      escalationCalls: 0,
      selfHealCalls: 0,
    },
    pricing: null,
    costEstimate: null,
    findings: [],
    steps: [],
    artifactsDir: runDir,
  };

  const createPlannerForLlm = (llmConfig) =>
    llmConfig.provider === "openai-compatible"
      ? createOpenAICompatiblePlanner({
          baseUrl: llmConfig.baseUrl,
          modelId: llmConfig.modelId,
          ...(llmConfig.apiKey ? { apiKey: llmConfig.apiKey } : {}),
        })
      : createBedrockPlanner({
          modelId: llmConfig.modelId,
          region: llmConfig.region,
          ...(llmConfig.inferenceConfig ? { inferenceConfig: llmConfig.inferenceConfig } : {}),
          ...(llmConfig.additionalModelRequestFields
            ? { additionalModelRequestFields: llmConfig.additionalModelRequestFields }
            : {}),
          ...(llmConfig.serviceTier ? { serviceTier: llmConfig.serviceTier } : {}),
          ...(llmConfig.promptCaching !== undefined ? { promptCaching: llmConfig.promptCaching } : {}),
          ...(llmConfig.supportsConditionalToolSchemas !== undefined
            ? { supportsConditionalToolSchemas: llmConfig.supportsConditionalToolSchemas }
            : {}),
          ...(llmConfig.supportsStrictToolUse !== undefined
            ? { supportsStrictToolUse: llmConfig.supportsStrictToolUse }
            : {}),
        });

  const planner = createPlannerForLlm(config.llm);
  const escalationPlanner = config.escalationLlm?.modelId
    ? createPlannerForLlm(config.escalationLlm)
    : null;

  const logger = createRunnerLogger(config.headed);
  const debugLogger = createDebugLogger(config.debug);
  const interactionProvider = createTerminalInteractionProvider();
  const formatObservationSummary = (observation) => {
    const visibleButtons = observation.controls.filter((control) => control.tag === "button").length;
    const visibleInputs = observation.controls.filter((control) => control.tag === "input").length;
    const visibleAlerts = observation.alerts.length;
    return `${observation.title || "untitled"} | ${observation.url} | controls=${observation.controls.length} buttons=${visibleButtons} inputs=${visibleInputs} alerts=${visibleAlerts}`;
  };

  const providerLabel = config.llm.provider === "openai-compatible"
    ? `openai-compatible:${config.llm.modelId}`
    : `bedrock:${config.llm.modelId}`;

  logger.info(`starting run ${runId} using ${providerLabel}`);

  logger.info(`running ${config.llm.provider} preflight against model ${config.llm.modelId}`);
  if (shouldInterrupt()) {
    return {
      status: "interrupted",
      error: "Interrupted by Ctrl-C."
    };
  }
  await planner.preflight();
  logger.info(`${config.llm.provider} preflight succeeded`);

  if (escalationPlanner) {
    logger.info(
      `running escalation preflight against model ${config.escalationLlm.modelId} (${config.escalationLlm.provider})`
    );
    await escalationPlanner.preflight();
    logger.info("escalation preflight succeeded");
  }

  if (shouldInterrupt()) {
    return {
      status: "interrupted",
      error: "Interrupted by Ctrl-C."
    };
  }

  const browserSession = await createPlaywrightBrowserFactory().launch({
    headed: config.headed,
    viewport: { width: 1440, height: 900 },
  });
  const { page } = browserSession;
  const runtimeErrorTracker = createRuntimeErrorTracker(page);
  const drainRuntimeErrors = () => scrubSecretsFromText(runtimeErrorTracker.drain(), secretValues);
  const plannerAbortController = new AbortController();
  page.once("close", () => {
    browserClosed = true;
    plannerAbortController.abort();
  });

  const currentPageUrl = () => {
    try {
      return browserClosed ? "" : page.url();
    } catch {
      return "";
    }
  };

  let stepIndex = 0;
  const actionHistory = [];
  const humanInputs = new Map();
  let observationTurn = 0;
  let lastUiActionAt = 0;
  let pendingInteractionRequest = null;
  let pendingScreenshotBuffer = null;
  const visitedPaths = new Set();
  const redirects = new Map();

  /*
   * Move past an item the run cannot get through, instead of ending the run.
   *
   * A sweep's value is the whole table, and a guard firing on item 12 used to
   * discard items 13 onward -- so one broken route hid every route after it, and
   * the report said "failed" rather than which parts pass and which do not.
   * Where the scenario declares the work, a stall becomes a recorded defect for
   * that item and a jump to the next outstanding one. Each skip consumes a path,
   * so this cannot loop.
   */
  const skipToNextOutstanding = async (why, severity = "major") => {
    const outstanding = requiredVisitedPaths(contextData).filter((path) => !visitedPaths.has(path));
    if (outstanding.length === 0) return false;

    const next = outstanding[0];
    report.findings.push({
      step: stepIndex,
      url: page.url(),
      severity,
      category: "functional",
      summary: `Could not complete work at ${pathOf(page.url())}: ${why}`,
      evidence: "Recorded by the runner after a stall; the run continued to the next required path."
    });
    logger.warn(`skipping to ${next} after: ${why}`);

    visitedPaths.add(next);
    try {
      await page.goto(new URL(next, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
    } catch (error) {
      logger.warn(`could not reach ${next}: ${errorMessage(error)}`);
    }

    lastProgressKey = null;
    stagnantTurns = 0;
    turnsSinceGoalProgress = 0;
    screenChangesSinceGoalProgress = 0;
    return true;
  };
  const metCriteria = new Set();
  let turnsSinceGoalProgress = 0;
  let lastRequiredCovered = 0;
  let goalCheckpointRequested = false;
  let progressCheckpoint = "";
  let outstandingWork = [];
  let screenChangesSinceGoalProgress = 0;
  let lastProgressKey = null;
  let stagnantTurns = 0;
  let previousTimedOutWait = null;
  let pendingEscalation = false;

  const captureViewportScreenshot = async (options = {}) => {
    throwIfInterrupted();
    return page.screenshot({
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      ...options,
    });
  };

  const captureArtifactScreenshot = async (options = {}) => {
    throwIfInterrupted();
    if (screenshots === "fullpage") {
      return page.screenshot({
        fullPage: true,
        animations: "disabled",
        caret: "hide",
        ...options,
      });
    }

    return captureViewportScreenshot(options);
  };

  // Written by the step body when the runner refuses an action rather than
  // throwing, so captureStep can record the refusal instead of "ok".
  const recoverableOutcomeRef = { current: null };
  const recoverableErrorRef = { current: null };

  async function captureStep(name, plannerAction, execute, stepDebugContext = undefined, metadata = undefined) {
    recoverableOutcomeRef.current = null;
    recoverableErrorRef.current = null;
    throwIfInterrupted();
    stepIndex += 1;
    const artifactBase = `${String(stepIndex).padStart(2, "0")}-${sanitizeSegment(name)}`;
    const screenshotName = `${artifactBase}.png`;
    const htmlName = `${artifactBase}.html`;
    const screenshotPath = path.join(screenshotsDir, screenshotName);
    const htmlPath = path.join(screenshotsDir, htmlName);
    const started = Date.now();

    let stepError = null;
    let stepScreenshotRelativePath;
    let stepHtmlRelativePath;
    try {
      await execute();
      throwIfInterrupted();
    } catch (error) {
      stepError = errorMessage(error);
      throw error;
    } finally {
      if (screenshots !== "none" && !browserClosed) {
        await page.waitForTimeout(120);
        await captureArtifactScreenshot({ path: screenshotPath });
        stepScreenshotRelativePath = path.relative(runDir, screenshotPath);
      }

      /*
       * Capture the DOM for any step that failed, even without --debug.
       *
       * A failing step is the only one anybody reads, and re-running with debug
       * to get it is a gamble: identical invocations of the same scenario have
       * produced wildly different paths, so the second run may fail somewhere
       * else or not at all. Capturing at the moment of failure costs one
       * page.content() on a step that already went wrong; capturing every step
       * costs ~370KB each and 5x the report size.
       */
      if ((config.debug || stepError) && !browserClosed) {
        const html = await page.content();
        await writeFile(htmlPath, html, "utf8");
        stepHtmlRelativePath = path.relative(runDir, htmlPath);
      }

      report.steps.push({
        index: stepIndex,
        name,
        durationMs: Date.now() - started,
        url: page.url(),
        screenshot: stepScreenshotRelativePath,
        html: stepHtmlRelativePath,
        plannerAction,
        observation: stepDebugContext?.observation,
        knownHumanInputs: stepDebugContext?.knownHumanInputs,
        plannerTokenUsage: stepDebugContext?.plannerTokenUsage,
        phase: metadata?.phase,
        initBlock: metadata?.initBlock,
        ...(metadata?.runtimeErrors?.length ? { runtimeErrors: metadata.runtimeErrors } : {}),
        /*
         * A step the runner refused -- a rejected finish, a target that could not
         * be resolved -- returns normally, so `stepError` is empty and it used to
         * be recorded as "ok". A rejected finish then read like an accepted one in
         * the trace, which is exactly the thing a reader is trying to see.
         */
        outcome: stepError ? "error" : recoverableOutcomeRef.current || "ok",
        error: stepError || recoverableErrorRef.current || undefined,
      });
    }
  }

  async function executeDeterministicAction(action, observation, turnToken) {
    const payload = action.payload;
    if (payload.action === "wait_until_gone") {
      const expectedText = payload.expectGone.documentText;
      const waitResult = await waitForDocumentTextGone(
        page,
        expectedText,
        config.settleDelayMs,
        config.settleTimeoutMs
      );
      if (!waitResult.completed) {
        throw new Error(
          `Timed out after ${waitResult.elapsedMs}ms waiting for document text to disappear (configured timeout: ${config.settleTimeoutMs}ms): '${formatExpectedDocumentText(expectedText)}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`
        );
      }
      return;
    }

    if (payload.action !== "click" && payload.action !== "fill") {
      throw new Error(`Unsupported initialization action: ${payload.action}`);
    }

    await executeBrowserAction({
      page,
      action,
      observation,
      turnToken,
      contextData,
      humanInputs,
      secretValues,
      settleDelayMs: config.settleDelayMs,
      settleTimeoutMs: config.settleTimeoutMs,
      baseUrl: config.baseUrl,
      logger,
      throwIfInterrupted,
    });

    lastUiActionAt = Date.now();
    pendingInteractionRequest = null;
  }

  // Re-grounds a recorded step whose target no longer resolves by asking the
  // planner to pick the equivalent control in the current UI, then executing it.
  async function healReplayStep(block, action, observation, turnToken) {
    const payload = action.payload;
    const objective = [
      `Reproduce a recorded regression step from block '${block.name}'.`,
      `Original intent: ${action.reason}`,
      `Original action: ${payload.action}${payload.action === "fill" ? ` with value "${payload.value}"` : ""}.`,
      "The recorded control could not be matched exactly in the current UI.",
      `Choose the single control that best matches the original intent and perform the equivalent ${payload.action}.`,
    ].join(" ");

    const messages = buildPlannerMessages({
      testPrompt: objective,
      personaText,
      workspacePromptText,
      contextData,
      secretValues,
      observation,
      actionHistory: [],
      humanInputs,
      screenshotRequested: false,
      strictTargetSelectors: config.llm.supportsStrictToolUse === true,
    });

    const result = await requestPlannerAction({
      planner,
      messages,
      signal: plannerAbortController.signal,
    });
    if (result.tokenUsage) {
      addTokenUsageTotals(report.tokenUsage, result.tokenUsage);
    }
    report.tokenUsage.selfHealCalls += 1;

    // Self-heal re-grounds a single step, so only the first action of the
    // returned turn is used.
    const healedPayload = result.action.actions[0];
    if (payload.action === "fill" && healedPayload.action !== "fill") {
      throw new Error(`Self-heal for a recorded fill produced '${healedPayload.action}'.`);
    }
    if (payload.action === "click" && !["click", "select_option"].includes(healedPayload.action)) {
      throw new Error(`Self-heal for a recorded click produced '${healedPayload.action}'.`);
    }

    // Preserve the recorded fill value so healing only re-grounds the target.
    const healedAction =
      payload.action === "fill"
        ? { reason: result.action.reason, payload: { ...healedPayload, value: payload.value } }
        : { reason: result.action.reason, payload: healedPayload };

    await executeBrowserAction({
      page,
      action: healedAction,
      observation,
      turnToken,
      contextData,
      humanInputs,
      secretValues,
      settleDelayMs: config.settleDelayMs,
      settleTimeoutMs: config.settleTimeoutMs,
      baseUrl: config.baseUrl,
      logger,
      throwIfInterrupted,
    });
    lastUiActionAt = Date.now();
    pendingInteractionRequest = null;
  }

  async function replayBlockAction(block, action, observation, turnToken) {
    const payload = action.payload;
    let healed = false;

    if (payload.action === "wait_until_gone") {
      await executeDeterministicAction(action, observation, turnToken);
    } else {
      try {
        await executeDeterministicAction(action, observation, turnToken);
      } catch (error) {
        const message = errorMessage(error);
        const canHeal = /not found|ambiguous/i.test(message);
        if (config.selfHeal === false || !canHeal) {
          throw error;
        }
        logger.warn(`self-healing recorded step in block '${block.name}': ${message}`);
        await healReplayStep(block, action, observation, turnToken);
        healed = true;
      }
    }

    if (action.expect?.urlIncludes && !page.url().includes(action.expect.urlIncludes)) {
      throw new Error(
        `Regression post-condition failed after ${payload.action}: expected URL to include '${action.expect.urlIncludes}', got '${page.url()}'.`
      );
    }

    return { healed };
  }

  try {
    throwIfInterrupted();

    await captureStep("open_start_page", undefined, async () => {
      throwIfInterrupted();
      logger.info(`navigating to ${config.baseUrl}`);
      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
    });

    for (const block of config.initBlocks || []) {
      logger.info(`replaying initialization block '${block.name}'`);
      for (const action of block.actions) {
        throwIfInterrupted();
        await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
        observationTurn += 1;
        const turnToken = `t${observationTurn}`;
        const observation = await collectObservation(page, observationConfig, turnToken);
        observation.runtimeErrors = drainRuntimeErrors();
        await captureStep(
          `init_${sanitizeSegment(block.name)}_${action.payload.action}`,
          action,
          () => replayBlockAction(block, action, observation, turnToken),
          config.debug ? { observation: redactSecretValues(observation, secretValues) } : undefined,
          { phase: "init", initBlock: block.name, runtimeErrors: observation.runtimeErrors }
        );
      }
    }

    /*
     * Verify the world before spending anything on the agent.
     *
     * A run against an unprepared app cannot say anything about the app, so it
     * should not be reported as though it did. Checked after init blocks, since
     * the setup they replay is usually what puts the world in the required state.
     */
    for (const precondition of preconditionsFrom(contextData)) {
      throwIfInterrupted();
      const description = precondition.describe || JSON.stringify(precondition);
      try {
        if (precondition.path) {
          await page.goto(new URL(precondition.path, config.baseUrl).toString(), {
            waitUntil: "domcontentloaded"
          });
          await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
        }
        observationTurn += 1;
        const check = await collectObservation(page, observationConfig, `p${observationTurn}`);
        const text = String(check.documentText || "");
        const wanted = precondition.documentTextIncludes;
        const unwanted = precondition.documentTextExcludes;
        const ok =
          (!wanted || text.toLowerCase().includes(String(wanted).toLowerCase())) &&
          (!unwanted || !text.toLowerCase().includes(String(unwanted).toLowerCase()));

        if (!ok) {
          report.status = "failed";
          report.outcome = "precondition-not-met";
          report.finalUrl = page.url();
          report.error =
            `Precondition not met: ${description}. The run was not started — this says ` +
            `nothing about the application, only that the environment was not prepared for it.`;
          logger.error(report.error);
          return;
        }
        logger.info(`precondition ok: ${description}`);
      } catch (error) {
        report.status = "failed";
        report.outcome = "precondition-not-met";
        report.error = `Could not verify precondition (${description}): ${errorMessage(error)}`;
        logger.error(report.error);
        return;
      }
    }

    for (let i = 0; i < config.maxSteps; i += 1) {
      throwIfInterrupted();
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
      observationTurn += 1;
      const turnToken = `t${observationTurn}`;
      const observation = await collectObservation(page, observationConfig, turnToken);
      observation.runtimeErrors = drainRuntimeErrors();
      throwIfInterrupted();
      visitedPaths.add(pathOf(page.url()));
      logger.info(`observation ${i + 1}: ${formatObservationSummary(observation)}`);

      const screenshotBufferForThisTurn = pendingScreenshotBuffer;
      pendingScreenshotBuffer = null;
      const knownHumanInputsSnapshot = Object.fromEntries(humanInputs.entries());

      const messages = buildPlannerMessages({
        ...(metCriteria.size || outstandingWork.length
          ? { goalProgress: { met: [...metCriteria], outstanding: outstandingWork } }
          : {}),
        testPrompt: scenario,
        personaText,
        workspacePromptText,
        contextData,
        secretValues,
        observation,
        actionHistory,
        humanInputs,
        screenshotRequested: Boolean(screenshotBufferForThisTurn),
        strictTargetSelectors: config.llm.supportsStrictToolUse === true,
      });

      debugLogger.log(
        `planner_input_step=${i + 1} provider=${config.llm.provider} hasScreenshot=${Boolean(screenshotBufferForThisTurn)}`
      );
      debugLogger.log("planner_system_begin");
      debugLogger.log(messages.systemText);
      debugLogger.log("planner_system_end");
      debugLogger.log("planner_user_begin");
      debugLogger.log(messages.debugUserText);
      debugLogger.log("planner_user_end");

      const callPlanner = async (activePlanner) => {
        const result = await requestPlannerAction({
          planner: activePlanner,
          messages,
          screenshotBuffer: screenshotBufferForThisTurn,
          signal: plannerAbortController.signal,
        });
        if (result.tokenUsage) {
          addTokenUsageTotals(report.tokenUsage, result.tokenUsage);
        }
        return result;
      };

      // Two-tier routing: escalate to the stronger model when the previous turn
      // hit a recoverable failure or the observation was truncated, and rescue a
      // give_up from the cheap model by retrying once with the escalation model.
      const escalateThisTurn =
        Boolean(escalationPlanner) && (pendingEscalation || Boolean(observation.truncated));
      let plannerResult = await callPlanner(escalateThisTurn ? escalationPlanner : planner);
      let usedEscalation = escalateThisTurn;
      if (escalateThisTurn) {
        report.tokenUsage.escalationCalls += 1;
        logger.info(`escalated planning to ${config.escalationLlm.modelId}`);
      }
      pendingEscalation = false;

      if (
        escalationPlanner &&
        !usedEscalation &&
        plannerResult.action.actions[0].action === "give_up"
      ) {
        logger.info(`primary planner gave up; retrying with ${config.escalationLlm.modelId}`);
        throwIfInterrupted();
        plannerResult = await callPlanner(escalationPlanner);
        usedEscalation = true;
        report.tokenUsage.escalationCalls += 1;
      }

      throwIfInterrupted();

      const { tokenUsage: plannerTokenUsage, action: plannerTurn } = plannerResult;

      // A turn is one or more actions. Execute the first here as the step's
      // primary action; any batched follow-ons run below without another planner
      // call. Batches are unlimited by default; maxActionsPerTurn caps them only
      // when set to a positive number (1 disables batching, 0/unset means no
      // cap).
      const actionCap = Number(config.maxActionsPerTurn);
      const actionLimit =
        Number.isFinite(actionCap) && actionCap >= 1 ? actionCap : plannerTurn.actions.length;
      const batchActions = plannerTurn.actions.slice(0, actionLimit);
      const plannerAction = { reason: plannerTurn.reason, payload: batchActions[0] };
      const plannerPayload = plannerAction.payload;
      if (batchActions.length > 1) {
        logger.info(`planner proposed a batch of ${batchActions.length} actions`);
      }

      logger.info(
        `planner action ${i + 1}: ${plannerPayload.action}${plannerPayload.action === "click" || plannerPayload.action === "fill" || plannerPayload.action === "select_option" ? ` target=${describeTarget(plannerPayload.target)}` : ""} reason=${clip(plannerAction.reason, 140)}`
      );

      const actionName = `${plannerPayload.action}_${("target" in plannerPayload
        ? plannerPayload.target.id
        : "containerId" in plannerPayload
          ? plannerPayload.containerId
          : "severity" in plannerPayload
            ? plannerPayload.severity
            : "selector")}`;

      let recoverableOutcome = null;
      let recoverableErrorMessage = "";
      let actionTarget;
      const stepDebugContext = config.debug
        ? {
            observation: redactSecretValues(observation, secretValues),
            knownHumanInputs: knownHumanInputsSnapshot,
            plannerTokenUsage,
          }
        : undefined;

      try {
      await captureStep(
        actionName,
        plannerAction,
        async () => {
          throwIfInterrupted();
          if (plannerPayload.action === "finish") {
            /*
             * Check the claim before accepting it.
             *
             * `status: "passed"` has only ever meant "the agent stopped
             * voluntarily" -- a run that visited nothing and finished
             * immediately passed by the same rule as one that did the work.
             * Both of the checks below are mechanical, and both have been wrong
             * in practice: sweeps have reported success having covered 0 of 30
             * routes and 3 of 9.
             */
            const missing = requiredVisitedPaths(contextData).filter(
              (candidate) => !visitedPaths.has(candidate)
            );
            if (missing.length > 0) {
              const shown = missing.slice(0, 12).join(", ");
              recoverableOutcome = "finish_incomplete";
              recoverableOutcomeRef.current = "finish_incomplete";
              recoverableErrorMessage =
                `finish rejected: ${missing.length} required path(s) were never visited: ` +
                `${shown}${missing.length > 12 ? `, +${missing.length - 12} more` : ""}.`;
              recoverableErrorRef.current = recoverableErrorMessage;
              logger.warn(recoverableErrorMessage);
              return;
            }

            logger.info(`finish accepted at ${page.url()}`);
            report.status = "passed";
            report.finalUrl = page.url();
            /*
             * Generate the summary when the planner omits it, rather than refusing.
             *
             * Refusing cost more than it gained: the field cannot be required in the
             * schema (that broke tool use outright on a weaker model), models
             * routinely omit it, and each refusal spent a turn — twice ending the run
             * on the very next planner call. The deliverable is the summary itself,
             * and a tool-free call can produce one from the run's own history whether
             * or not the model volunteered it.
             */
            report.summary = plannerPayload.summary;
            if (!report.summary && typeof planner.summarize === "function") {
              try {
                const done = actionHistory
                  .filter((entry) => entry.outcome === "ok")
                  .map((entry) => `- ${entry.action.payload.action}: ${clip(entry.action.reason, 110)}`)
                  .slice(-30)
                  .join("\n");
                report.summary = await planner.summarize(
                  `A web test run has just completed its objective.\n\nOBJECTIVE:\n${scenario}\n\n` +
                    `WHAT IT DID:\n${done}\n\n` +
                    `Write the verdict the objective asked for — for a sweep, the per-item table. ` +
                    `Report only what the actions above show; do not claim items never visited.`
                );
                logger.info("summary generated for a finish that omitted one");
              } catch (error) {
                logger.warn(`summary unavailable: ${errorMessage(error)}`);
              }
            }
            return;
          }

          if (plannerPayload.action === "give_up") {
            report.status = "failed";
            report.finalUrl = page.url();
            report.error = `Planner gave up: ${plannerAction.reason}`;
            logger.warn(report.error);
            return;
          }

          if (plannerPayload.action === "wait_until_gone") {
            const expectedText = plannerPayload.expectGone.documentText;
            const formattedExpectedText = formatExpectedDocumentText(expectedText);
            const waitKey = `${page.url()}::${formattedExpectedText}`;
            if (previousTimedOutWait === waitKey) {
              recoverableOutcome = "duplicate_wait";
              recoverableOutcomeRef.current = "duplicate_wait";
              recoverableErrorMessage = `The same wait_until_gone condition already timed out without a URL change: '${formattedExpectedText}'.`;
              recoverableErrorRef.current = recoverableErrorMessage;
              logger.warn(recoverableErrorMessage);
              return;
            }

            logger.info(`waiting for document text to disappear: ${clip(formattedExpectedText)}`);
            const waitResult = await waitForDocumentTextGone(
              page,
              expectedText,
              config.settleDelayMs,
              config.settleTimeoutMs
            );
            if (!waitResult.completed) {
              previousTimedOutWait = waitKey;
              recoverableOutcome = "wait_timeout";
              recoverableOutcomeRef.current = "wait_timeout";
              recoverableErrorMessage = `Timed out after ${waitResult.elapsedMs}ms waiting for document text to disappear (configured timeout: ${config.settleTimeoutMs}ms): '${formattedExpectedText}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`;
              recoverableErrorRef.current = recoverableErrorMessage;
              logger.warn(recoverableErrorMessage);
              return;
            }

            previousTimedOutWait = null;
            return;
          }

          previousTimedOutWait = null;

          if (plannerPayload.action === "request_user_input") {
            /*
             * A registered secret is the answer to most of these asks, and the
             * prompt alone does not reliably stop a model reaching for a human
             * first -- some ignore the instruction entirely. Correct it here
             * rather than ending the run: naming the available paths turns a
             * headless dead end into one wasted step.
             */
            if (secretValues.size > 0) {
              recoverableOutcome = "secret_available";
              recoverableOutcomeRef.current = "secret_available";
              recoverableErrorMessage =
                `Do not ask a human for this. The run has registered secrets: ` +
                `${[...secretValues.keys()].join(", ")}. Fill the matching field with ` +
                `{{secret:<path>}} using one of those paths.`;
              logger.warn(`refused request_user_input: ${recoverableErrorMessage}`);
              return;
            }

            if (!config.headed) {
              throw new Error("LLM got blocked: requested user input in headless mode.");
            }

            const inputKey =
              plannerPayload.inputKey
                ;

            const promptText =
              plannerPayload.inputPrompt
                ;

            if (!humanInputs.has(inputKey)) {
              logger.info(`requesting human input for key '${inputKey}'`);
              const enteredValue = await interactionProvider.requestInput(`${promptText}: `);
              throwIfInterrupted();
              if (!enteredValue) {
                throw new Error(`No value entered for '${inputKey}'.`);
              }
              humanInputs.set(inputKey, enteredValue);
              logger.info(`received human input for key '${inputKey}'`);
            }

            return;
          }

          if (plannerPayload.action === "request_user_interaction") {
            if (!config.headed) {
              throw new Error("LLM got blocked: requested user interaction in headless mode.");
            }

            // If we just acted on the UI, give the app a chance to transition
            // before escalating to the user.
            const sinceLastUiActionMs = Date.now() - lastUiActionAt;
            if (lastUiActionAt > 0 && sinceLastUiActionMs < 3500) {
              logger.info("deferring user interaction prompt until UI settles after recent action");
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            const interactionPrompt =
              plannerPayload.interactionPrompt;

            // Require the same interaction request twice (with same URL/prompt)
            // before prompting the human. This avoids transient false positives.
            const interactionKey = `${page.url()}::${interactionPrompt}`;
            if (!pendingInteractionRequest || pendingInteractionRequest.key !== interactionKey) {
              pendingInteractionRequest = { key: interactionKey, count: 1 };
              logger.info(
                `seen first interaction request for '${interactionPrompt}' on ${page.url()}; waiting to confirm`
              );
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            pendingInteractionRequest.count += 1;
            if (pendingInteractionRequest.count < 2) {
              logger.info(
                `re-seen interaction request for '${interactionPrompt}'; waiting one more cycle before prompting`
              );
              await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
              return;
            }

            logger.info(`prompting for human interaction: ${interactionPrompt}`);
            const interactionNote = await interactionProvider.requestInput(`${interactionPrompt}. Optional note: `);
            throwIfInterrupted();
            if (interactionNote) {
              const key = `interaction_note_${stepIndex}`;
              humanInputs.set(key, interactionNote);
            }

            pendingInteractionRequest = null;

            return;
          }

          if (plannerPayload.action === "request_screenshot") {
            logger.info(
              `planner requested the most recent screenshot${
                plannerPayload.screenshotPrompt ? `: ${clip(plannerPayload.screenshotPrompt, 140)}` : ""
              }`
            );

            // Capture immediately from the current viewport so transient popups
            // (menus, sheets) are preserved for the next planner turn. Overlay
            // set-of-marks so the vision model can target the same ids it sees
            // in the structured observation.
            const useSetOfMarks = config.setOfMarks !== false;
            let markCount = 0;
            if (useSetOfMarks) {
              markCount = await drawSetOfMarks(page, turnToken);
            }
            try {
              pendingScreenshotBuffer = await captureViewportScreenshot();
            } finally {
              if (useSetOfMarks) {
                await clearSetOfMarks(page);
              }
            }
            if (useSetOfMarks) {
              logger.info(`captured screenshot with ${markCount} set-of-marks labels`);
            }

            return;
          }

          if (plannerPayload.action === "report_finding") {
            report.findings.push({
              step: stepIndex,
              url: page.url(),
              severity: plannerPayload.severity,
              category: plannerPayload.category,
              summary: plannerPayload.summary,
              ...(plannerPayload.evidence ? { evidence: plannerPayload.evidence } : {}),
              reason: plannerAction.reason,
            });
            logger.info(
              `finding [${plannerPayload.severity}/${plannerPayload.category}]: ${clip(plannerPayload.summary, 140)}`
            );
            return;
          }

          if (
            plannerPayload.action !== "scroll" &&
            plannerPayload.action !== "click" &&
            plannerPayload.action !== "fill" &&
            plannerPayload.action !== "select_option" &&
            plannerPayload.action !== "hover" &&
            plannerPayload.action !== "press_key" &&
            plannerPayload.action !== "navigate" &&
            plannerPayload.action !== "go_back"
          ) {
            throw new Error(`Unsupported planner action: ${plannerPayload.action}`);
          }

          const result = await executeBrowserAction({
            page,
            action: plannerAction,
            observation,
            turnToken,
            actionHistory,
            contextData,
            humanInputs,
            secretValues,
            settleDelayMs: config.settleDelayMs,
            settleTimeoutMs: config.settleTimeoutMs,
            baseUrl: config.baseUrl,
            logger,
            throwIfInterrupted,
          });
          actionTarget = result.target;
          if (plannerPayload.action !== "scroll") {
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
          }
          return;
        },
        stepDebugContext,
        { runtimeErrors: observation.runtimeErrors }
      );
    } catch (error) {
        const recoverableKind = classifyRecoverableActionError(error);
        if (!recoverableKind) {
          throw error;
        }

        recoverableOutcome = recoverableKind;
        recoverableErrorMessage = errorMessage(error);
        logger.warn(`recoverable action failure (${recoverableKind}): ${recoverableErrorMessage}`);
        await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
      }

      /*
       * Record what was asked for, not only where we ended up.
       *
       * A route that always redirects can never satisfy a coverage requirement
       * for its own path -- /notification-rules and /search both land on
       * /notifications here, so requiring them would be unsatisfiable. Counting
       * the requested path fixes that, and the from/to pair is itself worth
       * reporting: two routes silently resolving to one page is the sort of thing
       * a sweep exists to surface.
       */
      if (plannerPayload.action === "navigate" && !recoverableOutcome) {
        try {
          const requested = pathOf(new URL(plannerPayload.url, page.url()).toString());
          const landed = pathOf(page.url());
          visitedPaths.add(requested);
          if (requested !== landed) redirects.set(requested, landed);
        } catch {
          // A malformed url is already the action's own failure; ignore it here.
        }
      }

      actionHistory.push({
        step: stepIndex,
        url: page.url(),
        action: plannerAction,
        ...(actionTarget ? { target: actionTarget } : {}),
        outcome: recoverableOutcome || "ok",
        runnerFeedback:
          recoverableOutcome === "finish_without_summary"
            ? "finish must include a summary field stating what you verified — the per-item verdict the scenario asked for. Return finish again with it."
            : recoverableOutcome === "finish_incomplete"
            ? "You have not visited every path the scenario requires. Navigate to each path named in the error, record a verdict for it, then finish. Do not finish again until they are covered."
            : recoverableOutcome === "not_fillable"
              ? "That control cannot hold text — it is a button or a container, not a field. Click it instead, or target the actual input."
            : recoverableOutcome === "ambiguous_target"
            ? "That selector matched more than one visible control. Target exactly one of them by its id (for example {\"id\": \"a5\"}) rather than by text or label. Duplicate names are normal -- the same nav item often appears in both a sidebar and a mobile bar."
            : recoverableOutcome === "secret_available"
            ? "The value you asked a human for is registered as a secret. Fill it with {{secret:<path>}} using a path from availableSecretPaths. Do not use request_user_input for it again."
            : recoverableOutcome === "disabled_target"
            ? "Click was blocked because the target is disabled. Resolve any prerequisite validation or required fields before trying again."
            : recoverableOutcome === "target_disappeared"
              ? "The target disappeared before the action could run, so the UI is transitioning. Inspect the fresh observation instead of repeating the action."
            : recoverableOutcome === "wait_timeout"
              ? "The requested document text did not disappear within the configured settle timeout. Inspect the current observation and choose a different action."
              : recoverableOutcome === "duplicate_wait"
                ? "The same wait condition already timed out without a state change. Choose a different action."
                  : recoverableOutcome === "invalid_selection"
                    ? "select_option is only valid for native select controls with an observed options list. For a custom combobox, click a visible role=option control."
                    : recoverableOutcome === "scroll_loop"
                      ? "Repeated alternating scrolling does not add evidence. Use completedWork and the current observation to take a non-scroll action or finish."
                      : recoverableOutcome === "scroll_boundary"
                        ? "The scroll container is at its boundary. Use the current observation to take a non-scroll action or finish."
            : undefined,
        error: recoverableErrorMessage || undefined,
      });

      // A recoverable failure means the current model is stuck; route the next
      // turn to the stronger model when one is configured.
      if (recoverableOutcome && escalationPlanner) {
        pendingEscalation = true;
      }

      // Multi-action batch: run the remaining planned actions without another
      // planner call. Every follow-on resolves against the SAME observation the
      // batch was planned from and is located by the per-turn stamp on the exact
      // element the planner saw, so ids can never be remapped to a different
      // control. If that element was replaced (a re-render or a validation node
      // shifted the DOM), the stamp is gone and the action is a recoverable
      // "target not found" that aborts the rest of the batch; the next planner
      // turn re-observes and re-plans. Independent actions (filling many fields,
      // toggling many rows) therefore run in one turn, while any real UI change
      // stops the batch instead of acting blindly.
      const batchable = new Set(["click", "fill", "select_option", "hover", "press_key"]);
      if (
        report.status === "running" &&
        !recoverableOutcome &&
        batchActions.length > 1 &&
        batchable.has(plannerPayload.action)
      ) {
        for (let b = 1; b < batchActions.length; b += 1) {
          const followPayload = batchActions[b];
          if (!batchable.has(followPayload.action)) break;
          throwIfInterrupted();

          const followAction = { reason: plannerTurn.reason, payload: followPayload };
          const followActionName = `batch_${followPayload.action}_${b + 1}`;
          let followOutcome = null;
          let followErrorMessage = "";
          let followTarget;

          try {
            await captureStep(
              followActionName,
              followAction,
              async () => {
                const result = await executeBrowserAction({
                  page,
                  action: followAction,
                  observation,
                  turnToken,
                  actionHistory,
                  contextData,
                  humanInputs,
                  secretValues,
                  settleDelayMs: config.settleDelayMs,
                  settleTimeoutMs: config.settleTimeoutMs,
                  baseUrl: config.baseUrl,
                  logger,
                  throwIfInterrupted,
                });
                followTarget = result.target;
                lastUiActionAt = Date.now();
                pendingInteractionRequest = null;
              },
              undefined,
              { phase: "batch" }
            );
          } catch (error) {
            const kind = classifyRecoverableActionError(error);
            if (!kind) throw error;
            followOutcome = kind;
            followErrorMessage = errorMessage(error);
            logger.info(`batch stopped at action ${b + 1} (${kind}): ${followErrorMessage}`);
            await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
          }

          actionHistory.push({
            step: stepIndex,
            url: page.url(),
            action: followAction,
            ...(followTarget ? { target: followTarget } : {}),
            outcome: followOutcome || "ok",
            batched: true,
            error: followErrorMessage || undefined,
          });

          // Any recoverable failure ends the batch; the next planner turn
          // re-observes and re-plans from the current state.
          if (followOutcome) {
            if (escalationPlanner) pendingEscalation = true;
            break;
          }
        }
      }

      /*
       * Circuit breaker: give up on an action that cannot succeed.
       *
       * Escalation (above) already routes the next turn to the stronger model
       * on a recoverable failure, which rescues most stuck planners. It cannot
       * rescue the case where the action itself is impossible -- an observed run
       * spent 40 of 80 steps filling a target that did not exist. Where
       * escalation is configured this still lets the stronger model try; the
       * default threshold of 3 aborts only after it has failed too.
       *
       * Aborting also produces a better QA result than exhausting the step
       * budget: "could not reach control X" names a defect, "max steps reached"
       * does not.
       */
      /*
       * No-progress guard.
       *
       * The circuit breaker below only catches an action repeated verbatim.
       * Real stalls rarely look like that: a planner works through a form
       * trying fill, then click, then wait, each one succeeding and none of
       * them advancing. Observed stalls burned 68 successful clicks on one
       * button and an entire step budget on a sign-in screen, and neither
       * tripped a repeat check.
       *
       * So this ignores the actions entirely and asks the only question that
       * matters: has the screen changed? When it has not for several turns in
       * a row, no further turn is going to help.
       */
      /*
       * Goal progress, as distinct from movement.
       *
       * An agent exploring the wrong half of the app changes screens on every
       * turn, so the no-progress guard below never fires -- it is busy, not
       * getting anywhere. Growth in the criteria the planner reports as met is
       * the only signal that separates the two.
       */
      const criteriaBefore = metCriteria.size;
      for (const label of plannerAction.criteriaMet ?? []) metCriteria.add(label);

      /*
       * Covering a required path is progress, and it is measured rather than
       * self-reported.
       *
       * A sweep's criteria *are* its paths. Judging progress only by the labels a
       * model volunteers meant a run steadily working through 24 routes was
       * declared lost for not narrating them -- punishing the one scenario shape
       * where progress is perfectly observable.
       */
      const requiredCovered = requiredVisitedPaths(contextData).filter((path) =>
        visitedPaths.has(path)
      ).length;
      const coverageGrew = requiredCovered > lastRequiredCovered;
      lastRequiredCovered = requiredCovered;

      if (metCriteria.size > criteriaBefore || coverageGrew) {
        turnsSinceGoalProgress = 0;
        screenChangesSinceGoalProgress = 0;
      } else {
        turnsSinceGoalProgress += 1;
      }

      const currentProgressKey = progressKey(page.url(), observation);
      if (currentProgressKey === lastProgressKey) {
        stagnantTurns += 1;
      } else {
        stagnantTurns = 0;
        screenChangesSinceGoalProgress += 1;
        lastProgressKey = currentProgressKey;
      }

      /*
       * Before judging a run lost, ask it what it has achieved.
       *
       * `criteriaMet` on the turn is unreliable -- it rides inside a tool call
       * the weaker models already struggle with, and one that never fills it in
       * would look identical to one that is genuinely wandering. A tool-free
       * checkpoint cannot fail that way, so the guard gets real evidence instead
       * of an absence, and the same record becomes the closing statement rather
       * than being recomputed from scratch at the end.
       */
      if (
        turnsSinceGoalProgress >= config.maxTurnsWithoutGoalProgress &&
        screenChangesSinceGoalProgress >= 3 &&
        typeof planner.summarize === "function" &&
        !goalCheckpointRequested
      ) {
        goalCheckpointRequested = true;
        try {
          const recent = actionHistory
            .filter((entry) => entry.outcome === "ok")
            .map((entry) => `- ${entry.action.payload.action}: ${clip(entry.action.reason, 100)}`)
            .slice(-20)
            .join("\n");
          const answer = await planner.summarize(
            `OBJECTIVE:\n${scenario}\n\nWHAT HAS BEEN DONE:\n${recent || "(nothing yet)"}\n\n` +
              `Audit the objective. Reply in exactly two sections and nothing else:\n` +
              `MET:\n(one short label per line for each success criterion definitely ` +
              `satisfied, or the single word NONE)\n` +
              `OUTSTANDING:\n(one short label per line for each criterion still to be done, ` +
              `or the single word NONE)`
          );
          progressCheckpoint = answer;
          const section = (name) => {
            const match = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:MET|OUTSTANDING):|$)`, "i").exec(
              answer
            );
            if (!match) return [];
            return match[1]
              .split("\n")
              .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
              .filter((line) => line && !/^NONE$/i.test(line))
              .map((line) => clip(line, 80));
          };
          for (const label of section("MET")) metCriteria.add(label);
          outstandingWork = section("OUTSTANDING");
          if (metCriteria.size > 0) {
            turnsSinceGoalProgress = 0;
            screenChangesSinceGoalProgress = 0;
            logger.info(`goal checkpoint: ${[...metCriteria].join("; ")}`);
          }
        } catch (error) {
          logger.warn(`goal checkpoint unavailable: ${errorMessage(error)}`);
        }
      }

      /*
       * Moving, but not arriving: the screen keeps changing, so nothing looks
       * wrong, yet the checkpoint above found no new criterion satisfied. That is
       * the signature of a path too convoluted to follow -- a finding about the
       * app, not a failure of the run.
       */
      if (
        goalCheckpointRequested &&
        turnsSinceGoalProgress >= config.maxTurnsWithoutGoalProgress &&
        screenChangesSinceGoalProgress >= 3
      ) {
        report.status = "failed";
        report.finalUrl = page.url();
        report.outcome = "lost";
        report.error =
          `Aborted after ${turnsSinceGoalProgress} turns without meeting a new success ` +
          `criterion, across ${screenChangesSinceGoalProgress} screen changes. The run kept ` +
          `moving without getting closer to the objective` +
          `${metCriteria.size ? ` (met so far: ${[...metCriteria].join(", ")})` : " (nothing met)"}.`;
        logger.error(report.error);
        break;
      }

      if (stagnantTurns >= config.maxStagnantTurns) {
        if (await skipToNextOutstanding(`no visible change for ${stagnantTurns} turns`)) continue;
        report.status = "failed";
        report.finalUrl = page.url();
        report.error =
          `Aborted after ${stagnantTurns} consecutive turns with no visible change at ` +
          `${page.url()} (last action: ${plannerPayload.action}). The run is not making ` +
          `progress; the screen is identical to where it was ${stagnantTurns} turns ago.`;
        logger.error(report.error);
        break;
      }

      if (recoverableOutcome) {
        const signature = actionSignature(plannerAction);
        const repeats = trailingFailureRepeats(actionHistory, signature);

        if (repeats >= config.maxRepeatedFailures) {
          if (
            await skipToNextOutstanding(
              `${plannerPayload.action} failed ${repeats} times (${recoverableOutcome})`
            )
          ) {
            continue;
          }
          report.status = "failed";
          report.finalUrl = page.url();
          report.error =
            `Aborted after the same action failed ${repeats} times in a row ` +
            `(${plannerPayload.action}${
              "target" in plannerPayload ? ` on ${describeTarget(plannerPayload.target)}` : ""
            }, outcome '${recoverableOutcome}'): ${recoverableErrorMessage}`;
          logger.error(report.error);
          break;
        }

        /*
         * One failure can be a transition; two is the planner working from a
         * picture of the page it does not have. It must spend a whole turn on
         * `request_screenshot` to get one, so hand it over unprompted.
         */
        if (repeats >= 2 && !pendingScreenshotBuffer && !browserClosed) {
          pendingScreenshotBuffer = await captureViewportScreenshot();
          logger.info("attached a screenshot after repeated failures (planner did not have to ask)");
        }
      }

      if (report.status !== "running") {
        break;
      }
    }

    throwIfInterrupted();

    if (report.status === "running") {
      report.status = "failed";
      report.finalUrl = page.url();
      report.error = `Max steps reached (${config.maxSteps}) before objective completion.`;
      logger.error(report.error);
    }
  } catch (error) {
    if (isInterruptError(error) || browserClosed) {
      report.status = "interrupted";
      report.finalUrl = currentPageUrl();
      report.error = browserClosed ? "Browser was closed." : error.message;
    } else {
      report.status = "failed";
      report.finalUrl = currentPageUrl();
      report.error = error instanceof Error ? error.message : String(error);
      logger.error(report.error);
      if (!browserClosed) {
        const failureScreenshot = path.join(screenshotsDir, "failure.png");
        await captureViewportScreenshot({ path: failureScreenshot });

        if (config.debug) {
          const failureHtmlPath = path.join(screenshotsDir, "failure.html");
          const html = await page.content();
          await writeFile(failureHtmlPath, html, "utf8");
        }
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();

    /*
     * Effort, so a reader can tell "worked first time" from "barely got there".
     * A goal met at 95% of the budget is a usability signal even though the run
     * passed.
     */
    const recoverableFailures = actionHistory.filter(
      (entry) => entry.outcome && entry.outcome !== "ok"
    ).length;
    if (redirects.size > 0) {
      report.redirects = [...redirects].map(([from, to]) => ({ from, to }));
    }

    /*
     * Addresses asked for, against distinct pages actually reached.
     *
     * A gap between the two is the app's route table collapsing: many URLs
     * resolving to one screen. It also explains runs that look stalled while
     * working correctly — the agent keeps requesting new addresses and keeps
     * landing somewhere it has already been, so every screen-based signal reads
     * as no progress.
     */
    const landedPages = new Set(
      report.steps.map((step) => pathOf(step.url || "")).filter(Boolean)
    );
    /*
     * Only meaningful for a run that navigated. A scenario driven by clicking
     * never requests an address, and reporting "0 requested, 3 reached" would put
     * a navigation statistic on a report that did no navigation -- the shape of
     * one scenario type leaking into every other.
     */
    if (visitedPaths.size > 0) {
      report.routeCollapse = {
        addressesRequested: visitedPaths.size,
        distinctPagesReached: landedPages.size,
        redirected: redirects.size
      };
    }

    const expectedSteps = expectedStepsFrom(contextData);
    report.effort = {
      stepsUsed: stepIndex,
      maxSteps: config.maxSteps,
      ...(expectedSteps
        ? {
            expectedSteps,
            stepDriftPct: Math.round(((stepIndex - expectedSteps) / expectedSteps) * 100)
          }
        : {}),
      recoverableFailures,
      criteriaMet: [...metCriteria],
      screenChangesSinceGoalProgress,
      turnsSinceGoalProgress
    };
    /*
     * Ask the agent what it achieved when a run ends short.
     *
     * `report.error` says why the runner stopped; it cannot say how close the
     * agent got, which criteria it satisfied, or whether it was blocked by the
     * app or simply could not find the path. Only the agent knows that, and it
     * is the difference between "the app cannot do this" and "the route to it is
     * too convoluted to follow".
     */
    if (report.status === "failed" && typeof planner.summarize === "function") {
      try {
        const done = actionHistory
          .filter((entry) => entry.outcome === "ok")
          .map((entry) => `- ${entry.action.payload.action}: ${clip(entry.action.reason, 120)}`)
          .slice(-25)
          .join("\n");
        report.closingStatement = await planner.summarize(
          `A web test run has ended without completing its objective.\n\n` +
            `OBJECTIVE:\n${scenario}\n\n` +
            `WHY IT STOPPED:\n${report.error}\n\n` +
            (progressCheckpoint
              ? `CRITERIA ALREADY CONFIRMED MET DURING THE RUN:\n${progressCheckpoint}\n\n`
              : "") +
            `WHAT IT DID (most recent successful actions):\n${done || "(nothing succeeded)"}\n\n` +
            `Write a short closing statement for a QA report:\n` +
            `1. What was achieved, concretely.\n` +
            `2. Which parts of the objective were NOT reached.\n` +
            `3. Whether the app could not do it, the path to it was hard to find, or the run ` +
            `simply ran out of actions — and what makes you say so.\n` +
            `Be specific and do not claim anything you did not verify.`
        );
      } catch (error) {
        // A missing post-mortem must never turn a reportable failure into a crash.
        logger.warn(`closing statement unavailable: ${errorMessage(error)}`);
      }
    }

    report.outcome =
      report.outcome ||
      classifyOutcome({
        status: report.status,
        error: report.error,
        metCriteria: metCriteria.size,
        recoverableFailures,
        stepsUsed: stepIndex,
        expectedSteps
      });

    const configuredPricing = getConfiguredModelPricing(config);
    if (configuredPricing) {
      report.pricing = {
        provider: config.llm.provider,
        modelId: config.llm.modelId,
        ...(config.llm.region ? { region: config.llm.region } : {}),
        ...configuredPricing,
      };
      report.costEstimate = calculateCostEstimate(report.tokenUsage, configuredPricing);
    }

    const finalRunId = createRunId(startedAt, resolveRunOutcome(report.status), runLabel);
    const finalRunDir = path.join(config.outputDir, finalRunId);
    await rename(runDir, finalRunDir);
    runId = finalRunId;
    runDir = finalRunDir;
    report.runId = runId;
    report.artifactsDir = runDir;

    const reportPath = path.join(runDir, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const generatedReports = await generateReportArtifacts(reportPath, config.reports);
    const { summaryPath, summaryHtmlPath } = generatedReports;

    const latestManifestPath = path.join(config.outputDir, "latest.json");
    const latestManifest = {
      runId,
      status: report.status,
      finalUrl: report.finalUrl,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      artifactsDir: runDir,
      reportPath,
      summaryPath,
      summaryHtmlPath,
      provider: config.llm.provider,
      modelId: config.llm.modelId,
      ...(config.llm.region ? { region: config.llm.region } : {}),
      costEstimate: report.costEstimate,
    };
    await writeFile(latestManifestPath, `${JSON.stringify(latestManifest, null, 2)}\n`, "utf8");

    runtimeErrorTracker.dispose();
    await browserSession.close();

    const statusPrefix = report.status === "passed"
      ? "PASS"
      : report.status === "interrupted"
        ? "INTERRUPTED"
        : "FAIL";

    if (report.status === "failed" && report.error) {
      process.stderr.write(`Failure reason: ${report.error}\n`);
    }

    process.stdout.write(`${statusPrefix}: ${runDir}\n`);
    logger.info(`finished run with status ${report.status}`);

    if (report.status !== "passed" && report.status !== "interrupted") {
      process.exitCode = 1;
    }
  }

  return report;
}

function createInterruptError(message) {
  const error = new Error(message);
  error.name = "InterruptError";
  return error;
}

function isInterruptError(error) {
  return error instanceof Error && error.name === "InterruptError";
}
