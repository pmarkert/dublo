import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { generateReportArtifacts, rerenderReportArtifacts } from "../reporting/report-artifacts.mjs";
import { createBedrockPlanner } from "../node/bedrock-planner.js";
import { PlannerParseError } from "../ports/planner.js";
import { createOpenAICompatiblePlanner } from "../node/openai-compatible-planner.js";
import { createPlaywrightBrowserFactory } from "../node/playwright-browser.js";
import { createTerminalInteractionProvider } from "../node/terminal-interaction.js";
import { loadContextFromOperations, redactSecretValues, scrubSecretsFromText } from "./scenario/context-operations.mjs";
import { createRuntimeErrorTracker } from "./scenario/runtime-errors.mjs";
import { drawSetOfMarks, clearSetOfMarks } from "./scenario/set-of-marks.mjs";
import { buildPlannerMessages } from "./scenario/planner-context.mjs";
import { loadObservationConfig, normalizeScreenshotMode } from "./scenario/observation-config.mjs";
import { collectObservation } from "./scenario/observation.mjs";
import { addTokenUsageTotals, calculateCostEstimate, getConfiguredModelPricing, subtractTokenUsage } from "./scenario/pricing.mjs";
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
      formatRetries: 0,
    },
    // Recorded steps that still matched by description but whose control
    // identity (fingerprint) changed since the block was imported.
    controlDrift: 0,
    // Token usage attributable to the escalation model alone (also included in
    // the tokenUsage totals above); lets the cost estimate price each tier at
    // its own rates.
    escalationTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      plannerCalls: 0,
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
  let previousTimedOutWait = null;
  let pendingEscalation = false;
  let pendingEscalationReason = null;

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

  async function captureStep(name, plannerAction, execute, stepDebugContext = undefined, metadata = undefined) {
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

      if (config.debug && !browserClosed) {
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
        observationSharedFromStep: stepDebugContext?.observationSharedFromStep,
        knownHumanInputs: stepDebugContext?.knownHumanInputs,
        plannerTokenUsage: stepDebugContext?.plannerTokenUsage,
        phase: metadata?.phase,
        initBlock: metadata?.initBlock,
        plannerModel: metadata?.plannerModel,
        ...(metadata?.target ? { target: metadata.target } : {}),
        ...(metadata?.controlDrift ? { controlDrift: true } : {}),
        ...(metadata?.fingerprint ? { fingerprint: metadata.fingerprint } : {}),
        ...(metadata?.escalated
          ? { escalated: true, escalationReason: metadata.escalationReason }
          : {}),
        ...(metadata?.runtimeErrors?.length ? { runtimeErrors: metadata.runtimeErrors } : {}),
        outcome: stepError ? "error" : "ok",
        error: stepError || undefined,
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
      return {};
    }

    if (payload.action !== "click" && payload.action !== "fill") {
      throw new Error(`Unsupported initialization action: ${payload.action}`);
    }

    const result = await executeBrowserAction({
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
    return result;
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
    let drifted = false;
    let result;

    if (payload.action === "wait_until_gone") {
      await executeDeterministicAction(action, observation, turnToken);
    } else {
      try {
        result = await executeDeterministicAction(action, observation, turnToken);
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

    // A recorded step resolves by DESCRIPTION (label/text/role/type), which can
    // match a control that is no longer the one that was recorded. The
    // fingerprint captured at import time detects exactly that: same
    // description, different identity. Not fatal - the action already matched
    // and ran - but it is the signal that a recorded flow is drifting and the
    // block may need re-importing.
    if (action.fingerprint && result?.fingerprint && result.fingerprint !== action.fingerprint) {
      drifted = true;
      logger.warn(
        `control drift in block '${block.name}': ${payload.action} matched by description, but the control's fingerprint changed since import (recorded ${action.fingerprint}, now ${result.fingerprint}). Re-import the block if this is intentional.`
      );
    }

    if (action.expect?.urlIncludes && !page.url().includes(action.expect.urlIncludes)) {
      throw new Error(
        `Regression post-condition failed after ${payload.action}: expected URL to include '${action.expect.urlIncludes}', got '${page.url()}'.`
      );
    }

    return {
      healed,
      drifted,
      ...(result?.target ? { target: result.target } : {}),
      ...(result?.fingerprint ? { fingerprint: result.fingerprint } : {}),
    };
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
        let replayOutcome = {};
        await captureStep(
          `init_${sanitizeSegment(block.name)}_${action.payload.action}`,
          action,
          async () => {
            replayOutcome = await replayBlockAction(block, action, observation, turnToken);
          },
          config.debug ? { observation: redactSecretValues(observation, secretValues) } : undefined,
          {
            phase: "init",
            initBlock: block.name,
            runtimeErrors: observation.runtimeErrors,
            get controlDrift() {
              return replayOutcome.drifted === true;
            },
            get target() {
              return replayOutcome.target;
            },
            // The identity the control has NOW; re-importing the block picks
            // this up, which is how a drifted block gets re-baselined.
            get fingerprint() {
              return replayOutcome.fingerprint;
            },
          }
        );
        if (replayOutcome.drifted) report.controlDrift += 1;
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
      logger.info(`observation ${i + 1}: ${formatObservationSummary(observation)}`);

      const screenshotBufferForThisTurn = pendingScreenshotBuffer;
      pendingScreenshotBuffer = null;
      const knownHumanInputsSnapshot = Object.fromEntries(humanInputs.entries());

      const messages = buildPlannerMessages({
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

      // What produced this turn's plan — recorded on the step so the report
      // shows which model drove it and why escalation happened.
      const turnPlanning = {
        model: config.llm.modelId,
        escalated: false,
        escalationReason: null,
      };

      const callPlannerOnce = async (activePlanner, activeMessages) => {
        const result = await requestPlannerAction({
          planner: activePlanner,
          messages: activeMessages,
          screenshotBuffer: screenshotBufferForThisTurn,
          signal: plannerAbortController.signal,
        });
        if (result.tokenUsage) {
          addTokenUsageTotals(report.tokenUsage, result.tokenUsage);
          if (escalationPlanner && activePlanner === escalationPlanner) {
            addTokenUsageTotals(report.escalationTokenUsage, result.tokenUsage);
          }
        }
        return result;
      };

      // A planner failure the run recovered from still deserves a visible step:
      // the report should show the failed attempt and the retry, not silently
      // merge them into one entry.
      const recordPlannerFailureStep = (name, phase, model, retriedWith, errorText) => {
        stepIndex += 1;
        report.steps.push({
          index: stepIndex,
          name,
          durationMs: 0,
          url: page.url(),
          phase,
          plannerModel: model,
          ...(retriedWith ? { retriedWith } : {}),
          outcome: "error",
          error: errorText,
        });
      };

      const withValidationFeedback = (validationMessage) => ({
        ...messages,
        dynamicContextText: `${messages.dynamicContextText}\n\nYour previous planner_action call was rejected because it failed schema validation:\n${validationMessage}\nReturn a corrected planner_action call that satisfies the schema. Remember: findings belong in the top-level findings array, not in actions, and only click, fill, select_option, hover, and press_key may share a turn.`,
      });

      // A schema-invalid turn is a formatting slip, not a dead model: retry
      // once on the same model with the validation message fed back, then once
      // on the escalation model when one is configured. With prompt caching the
      // retries re-read the cached prefix, so they are cheap. Only after all
      // repair attempts fail does the error propagate and fail the run.
      const callPlanner = async (activePlanner) => {
        const activeModel =
          escalationPlanner && activePlanner === escalationPlanner
            ? config.escalationLlm.modelId
            : config.llm.modelId;
        try {
          return await callPlannerOnce(activePlanner, messages);
        } catch (error) {
          if (!(error instanceof PlannerParseError)) throw error;
          report.tokenUsage.formatRetries += 1;
          logger.warn(
            `planner turn failed validation; retrying with feedback: ${clip(error.validationMessage, 200)}`
          );
          recordPlannerFailureStep(
            "planner_invalid_turn",
            "planner_repair",
            activeModel,
            activeModel,
            error.validationMessage
          );
          throwIfInterrupted();
          try {
            return await callPlannerOnce(activePlanner, withValidationFeedback(error.validationMessage));
          } catch (retryError) {
            if (!(retryError instanceof PlannerParseError)) throw retryError;
            if (!escalationPlanner || activePlanner === escalationPlanner) throw retryError;
            report.tokenUsage.formatRetries += 1;
            report.tokenUsage.escalationCalls += 1;
            logger.warn(
              `retried turn still failed validation; repairing with ${config.escalationLlm.modelId}`
            );
            recordPlannerFailureStep(
              "planner_invalid_turn",
              "planner_repair",
              activeModel,
              config.escalationLlm.modelId,
              retryError.validationMessage
            );
            turnPlanning.model = config.escalationLlm.modelId;
            turnPlanning.escalated = true;
            turnPlanning.escalationReason = "invalid planner turn persisted after one retry";
            throwIfInterrupted();
            return await callPlannerOnce(
              escalationPlanner,
              withValidationFeedback(retryError.validationMessage)
            );
          }
        }
      };

      // Two-tier routing: escalate to the stronger model when the previous turn
      // hit a recoverable failure or the observation was truncated, and rescue a
      // give_up from the cheap model by retrying once with the escalation model.
      const escalateThisTurn =
        Boolean(escalationPlanner) && (pendingEscalation || Boolean(observation.truncated));
      if (escalateThisTurn) {
        turnPlanning.model = config.escalationLlm.modelId;
        turnPlanning.escalated = true;
        turnPlanning.escalationReason = pendingEscalationReason || "observation truncated";
      }
      let plannerResult = await callPlanner(escalateThisTurn ? escalationPlanner : planner);
      let usedEscalation = escalateThisTurn;
      if (escalateThisTurn) {
        report.tokenUsage.escalationCalls += 1;
        logger.info(
          `escalated planning to ${config.escalationLlm.modelId} (${turnPlanning.escalationReason})`
        );
      }
      pendingEscalation = false;
      pendingEscalationReason = null;

      if (
        escalationPlanner &&
        !usedEscalation &&
        plannerResult.action.actions[0].action === "give_up"
      ) {
        logger.info(`primary planner gave up; retrying with ${config.escalationLlm.modelId}`);
        recordPlannerFailureStep(
          "planner_gave_up",
          "planner_rescue",
          config.llm.modelId,
          config.escalationLlm.modelId,
          `Primary planner gave up: ${plannerResult.action.reason}`
        );
        turnPlanning.model = config.escalationLlm.modelId;
        turnPlanning.escalated = true;
        turnPlanning.escalationReason = "primary planner gave up";
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
          : "selector")}`;

      let recoverableOutcome = null;
      let recoverableErrorMessage = "";
      let actionTarget;
      let actionFingerprint;
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

          // Findings are a turn-level annotation: record them before the
          // action dispatch so they land even when the action itself fails.
          for (const finding of plannerTurn.findings ?? []) {
            report.findings.push({
              step: stepIndex,
              url: page.url(),
              severity: finding.severity,
              category: finding.category,
              summary: finding.summary,
              ...(finding.evidence ? { evidence: finding.evidence } : {}),
              reason: plannerTurn.reason,
            });
            logger.info(
              `finding [${finding.severity}/${finding.category}]: ${clip(finding.summary, 140)}`
            );
          }

          if (plannerPayload.action === "finish") {
            logger.info(`finish accepted at ${page.url()}`);
            report.status = "passed";
            report.finalUrl = page.url();
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
              recoverableErrorMessage = `The same wait_until_gone condition already timed out without a URL change: '${formattedExpectedText}'.`;
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
              recoverableErrorMessage = `Timed out after ${waitResult.elapsedMs}ms waiting for document text to disappear (configured timeout: ${config.settleTimeoutMs}ms): '${formattedExpectedText}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`;
              logger.warn(recoverableErrorMessage);
              return;
            }

            previousTimedOutWait = null;
            return;
          }

          previousTimedOutWait = null;

          if (plannerPayload.action === "request_user_input") {
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
          actionFingerprint = result.fingerprint;
          if (plannerPayload.action !== "scroll") {
            lastUiActionAt = Date.now();
            pendingInteractionRequest = null;
          }
          return;
        },
        stepDebugContext,
        {
          runtimeErrors: observation.runtimeErrors,
          plannerModel: turnPlanning.model,
          // Resolved during execute(), so these are read back as getters after
          // the action runs. step.target is what `block import` turns into a
          // descriptive (id-free) replay selector; step.fingerprint is the
          // recorded identity that later replays check for drift.
          get target() {
            return actionTarget;
          },
          get fingerprint() {
            return actionFingerprint;
          },
          ...(turnPlanning.escalated
            ? { escalated: true, escalationReason: turnPlanning.escalationReason }
            : {}),
        }
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

      actionHistory.push({
        step: stepIndex,
        url: page.url(),
        action: plannerAction,
        ...(actionTarget ? { target: actionTarget } : {}),
        ...(actionFingerprint ? { fingerprint: actionFingerprint } : {}),
        outcome: recoverableOutcome || "ok",
        runnerFeedback:
          recoverableOutcome === "disabled_target"
            ? "Click was blocked because the target is disabled. Resolve any prerequisite validation or required fields before trying again."
            : recoverableOutcome === "target_disappeared"
              ? "The target disappeared before the action could run, so the UI is transitioning. Inspect the fresh observation instead of repeating the action."
            : recoverableOutcome === "ambiguous_target"
              ? "The selector matched more than one visible control (the error names the candidate ids). Target the control by its id alone - ids are unique within an observation. A button and an element nested inside it often share the same text and label."
            : recoverableOutcome === "target_field_mismatch"
              ? "The id names a real control, but another supplied selector field contradicts what was observed for it. Use { id } alone, copied from the current observation; never add field values the observation does not show."
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
        pendingEscalationReason = `previous action hit a recoverable failure (${recoverableOutcome})`;
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
        // Every follow-on shares the primary step's observation by design, so
        // its debug record carries a pointer to that step instead of a full
        // copy (which would multiply the report by the batch length) and no
        // plannerTokenUsage (the planner call belongs to the primary step).
        const primaryStepIndex = stepIndex;
        const batchDebugContext = config.debug
          ? { observationSharedFromStep: primaryStepIndex }
          : undefined;
        for (let b = 1; b < batchActions.length; b += 1) {
          const followPayload = batchActions[b];
          if (!batchable.has(followPayload.action)) break;
          throwIfInterrupted();

          const followAction = { reason: plannerTurn.reason, payload: followPayload };
          const followActionName = `batch_${followPayload.action}_${b + 1}`;
          let followOutcome = null;
          let followErrorMessage = "";
          let followTarget;
          let followFingerprint;

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
                followFingerprint = result.fingerprint;
                lastUiActionAt = Date.now();
                pendingInteractionRequest = null;
              },
              batchDebugContext,
              {
                phase: "batch",
                get target() {
                  return followTarget;
                },
                get fingerprint() {
                  return followFingerprint;
                },
              }
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
            ...(followFingerprint ? { fingerprint: followFingerprint } : {}),
            outcome: followOutcome || "ok",
            batched: true,
            error: followErrorMessage || undefined,
          });

          // Any recoverable failure ends the batch; the next planner turn
          // re-observes and re-plans from the current state.
          if (followOutcome) {
            if (escalationPlanner) {
              pendingEscalation = true;
              pendingEscalationReason = `a batched action hit a recoverable failure (${followOutcome})`;
            }
            break;
          }
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

    const configuredPricing = getConfiguredModelPricing(config);
    if (configuredPricing) {
      report.pricing = {
        provider: config.llm.provider,
        modelId: config.llm.modelId,
        ...(config.llm.region ? { region: config.llm.region } : {}),
        ...configuredPricing,
      };

      const escalationUsage = report.escalationTokenUsage;
      const escalationUsed = escalationUsage && escalationUsage.totalTokens > 0;
      if (!escalationUsed) {
        report.costEstimate = calculateCostEstimate(report.tokenUsage, configuredPricing);
      } else {
        // Price each tier at its own rates: the escalation model's usage at the
        // escalation profile's configured prices (falling back to the primary's
        // rates when that profile has none), the remainder at the primary's.
        const escalationPricing =
          (config.escalationLlm && getConfiguredModelPricing({ llm: config.escalationLlm })) ||
          configuredPricing;
        const primaryUsage = subtractTokenUsage(report.tokenUsage, escalationUsage);
        const primaryEstimate = calculateCostEstimate(primaryUsage, configuredPricing);
        const escalationEstimate = calculateCostEstimate(escalationUsage, escalationPricing);
        const round = (value) => Number(value.toFixed(10));
        report.costEstimate = {
          currency: configuredPricing.currency,
          tokenUnit: configuredPricing.tokenUnit,
          rates: primaryEstimate.rates,
          costs: {
            input: round(primaryEstimate.costs.input + escalationEstimate.costs.input),
            output: round(primaryEstimate.costs.output + escalationEstimate.costs.output),
            cacheRead: round(primaryEstimate.costs.cacheRead + escalationEstimate.costs.cacheRead),
            cacheWrite: round(
              primaryEstimate.costs.cacheWrite + escalationEstimate.costs.cacheWrite
            ),
            total: round(primaryEstimate.costs.total + escalationEstimate.costs.total),
          },
          primary: { costs: primaryEstimate.costs },
          escalation: {
            modelId: config.escalationLlm.modelId,
            rates: escalationEstimate.rates,
            costs: escalationEstimate.costs,
          },
        };
      }
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
