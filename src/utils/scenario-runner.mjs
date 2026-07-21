import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { generateReportArtifacts, rerenderReportArtifacts } from "../reporting/report-artifacts.mjs";
import { createBedrockPlanner } from "../node/bedrock-planner.js";
import { createOpenAICompatiblePlanner } from "../node/openai-compatible-planner.js";
import { createPlaywrightBrowserFactory } from "../node/playwright-browser.js";
import { createTerminalInteractionProvider } from "../node/terminal-interaction.js";
import { loadContextFromOperations, redactSecretValues } from "./scenario/context-operations.mjs";
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
    },
    pricing: null,
    costEstimate: null,
    steps: [],
    artifactsDir: runDir,
  };

  const planner =
    config.llm.provider === "openai-compatible"
      ? createOpenAICompatiblePlanner({
          baseUrl: config.llm.baseUrl,
          modelId: config.llm.modelId,
          ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
        })
      : createBedrockPlanner({
          modelId: config.llm.modelId,
          region: config.llm.region,
          ...(config.llm.inferenceConfig ? { inferenceConfig: config.llm.inferenceConfig } : {}),
          ...(config.llm.additionalModelRequestFields
            ? { additionalModelRequestFields: config.llm.additionalModelRequestFields }
            : {}),
          ...(config.llm.serviceTier ? { serviceTier: config.llm.serviceTier } : {}),
          ...(config.llm.supportsConditionalToolSchemas !== undefined
            ? { supportsConditionalToolSchemas: config.llm.supportsConditionalToolSchemas }
            : {}),
          ...(config.llm.supportsStrictToolUse !== undefined
            ? { supportsStrictToolUse: config.llm.supportsStrictToolUse }
            : {}),
        });

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
        knownHumanInputs: stepDebugContext?.knownHumanInputs,
        plannerTokenUsage: stepDebugContext?.plannerTokenUsage,
        phase: metadata?.phase,
        initBlock: metadata?.initBlock,
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
          `Timed out waiting for document text to disappear: '${formatExpectedDocumentText(expectedText)}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`
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
      logger,
      throwIfInterrupted,
    });

    lastUiActionAt = Date.now();
    pendingInteractionRequest = null;
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
        await captureStep(
          `init_${sanitizeSegment(block.name)}_${action.payload.action}`,
          action,
          () => executeDeterministicAction(action, observation, turnToken),
          config.debug ? { observation: redactSecretValues(observation, secretValues) } : undefined,
          { phase: "init", initBlock: block.name }
        );
      }
    }

    for (let i = 0; i < config.maxSteps; i += 1) {
      throwIfInterrupted();
      await waitForUiSettle(page, config.settleDelayMs, config.settleTimeoutMs);
      observationTurn += 1;
      const turnToken = `t${observationTurn}`;
      const observation = await collectObservation(page, observationConfig, turnToken);
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

      const plannerResult = await requestPlannerAction({
        planner,
        messages,
        screenshotBuffer: screenshotBufferForThisTurn,
        signal: plannerAbortController.signal,
      });

      throwIfInterrupted();

      const { tokenUsage: plannerTokenUsage, action: plannerAction } = plannerResult;

      if (plannerTokenUsage) {
        addTokenUsageTotals(report.tokenUsage, plannerTokenUsage);
      }

      const plannerPayload = plannerAction.payload;

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
              recoverableErrorMessage = `Timed out waiting for document text to disappear: '${formattedExpectedText}'. Current document text: '${clip(waitResult.latestDocumentText, 240)}'.`;
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
            // (menus, sheets) are preserved for the next planner turn.
            pendingScreenshotBuffer = await captureViewportScreenshot();

            return;
          }

          if (
            plannerPayload.action !== "scroll" &&
            plannerPayload.action !== "click" &&
            plannerPayload.action !== "fill" &&
            plannerPayload.action !== "select_option"
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
        stepDebugContext
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
        outcome: recoverableOutcome || "ok",
        runnerFeedback:
          recoverableOutcome === "disabled_target"
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
            : undefined,
        error: recoverableErrorMessage || undefined,
      });

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
