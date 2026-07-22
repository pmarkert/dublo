import { resolveFillValue } from "./context-operations.mjs";

function normalizeDocumentText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function describeTarget(target) {
  return target ? JSON.stringify(target) : "none";
}

export function formatExpectedDocumentText(expectedText) {
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
  return expectedTexts.map((item) => normalizeDocumentText(item)).join("|");
}

export function isDocumentTextGone(documentText, expectedText) {
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
  const normalizedDocumentText = normalizeDocumentText(documentText);
  return expectedTexts.every((item) => !normalizedDocumentText.includes(normalizeDocumentText(item)));
}

function normalizeTargetValue(value) {
  return typeof value === "string" ? normalizeDocumentText(value) : value;
}

export function resolveTargetControl(controls, targetSelector) {
  const selectorEntries = Object.entries(targetSelector || {});
  const matches = controls.filter((control) =>
    selectorEntries.every(([key, expectedValue]) => {
      const actualValue = key === "disabled" ? Boolean(control.disabled) : control[key];
      return normalizeTargetValue(actualValue) === normalizeTargetValue(expectedValue);
    })
  );

  if (matches.length === 1) return matches[0];

  const selectorText = JSON.stringify(targetSelector);
  if (matches.length === 0) {
    throw new Error(`Planner target is not in the current observation: ${selectorText}`);
  }
  throw new Error(`Planner target selector is ambiguous: ${selectorText} matched ${matches.length} controls.`);
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "");
}

export function classifyRecoverableActionError(error) {
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("element is not enabled") ||
    message.includes("<button disabled") ||
    message.includes("disabled target before click")
  ) {
    return "disabled_target";
  }
  if (message.includes("selected option before click")) return "already_selected";
  if (message.includes("planner target is not in the current observation")) return "invalid_target";
  if (message.includes("planner target disappeared from the dom")) return "target_disappeared";
  if (message.includes("planner select_option target is not a native select")) return "invalid_selection";
  if (message.includes("alternating scroll loop")) return "scroll_loop";
  if (message.includes("cannot scroll down") || message.includes("cannot scroll up") || message.includes("did not move")) {
    return "scroll_boundary";
  }
  return null;
}

export function isAlternatingScrollLoop(actionHistory, nextAction) {
  if (nextAction.action !== "scroll") return false;

  const recentScrolls = actionHistory
    .filter(
      ({ outcome, action }) =>
        outcome === "ok" &&
        action.payload.action === "scroll" &&
        action.payload.containerId === nextAction.containerId
    )
    .slice(-4)
    .map(({ action }) => action.payload.direction);
  if (recentScrolls.length < 4) return false;

  return [...recentScrolls, nextAction.direction].every(
    (direction, index, directions) => index === 0 || direction !== directions[index - 1]
  );
}

export async function waitForUiSettle(page, settleDelayMs, settleTimeoutMs) {
  const minStableMs = Number.isFinite(settleDelayMs) ? Math.max(1, Number(settleDelayMs)) : 500;
  const maxWaitMs = Number.isFinite(settleTimeoutMs) ? Math.max(minStableMs, Number(settleTimeoutMs)) : 3000;
  const pollMs = 120;
  const startedAt = Date.now();
  let stableSince = Date.now();
  let previousSignature = "";

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(1200, maxWaitMs) });
  } catch {
    // SPA transitions do not always trigger load states.
  }

  while (Date.now() - startedAt < maxWaitMs) {
    const signature = await page.evaluate(() => {
      const controls = Array.from(
        globalThis.document.querySelectorAll(
          "button, a, input, textarea, select, [role='button'], [role='link'], [contenteditable='true']"
        )
      )
        .filter((element) => {
          const style = globalThis.window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 40)
        .map((element) => {
          const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
          const ariaLabel = (element.getAttribute("aria-label") || "").slice(0, 40);
          const disabled =
            ("disabled" in element && Boolean(element.disabled)) || element.getAttribute("aria-disabled") === "true";
          return `${element.tagName}:${disabled ? "1" : "0"}:${text}:${ariaLabel}`;
        })
        .join("|");
      const alerts = Array.from(globalThis.document.querySelectorAll("[role='alert']"))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80))
        .join("|");
      return `${globalThis.window.location.href}::${globalThis.document.title}::${controls}::${alerts}`;
    });

    if (signature !== previousSignature) {
      previousSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= minStableMs) {
      return;
    }
    await page.waitForTimeout(pollMs);
  }
}

export async function waitForDocumentTextGone(page, expectedText, settleDelayMs, settleTimeoutMs) {
  const startedAt = Date.now();
  const pollMs = 120;
  let absentSince = null;
  let latestDocumentText = "";
  while (Date.now() - startedAt < settleTimeoutMs) {
    latestDocumentText = await page.evaluate(() => String(globalThis.document.body?.innerText || "").replace(/\s+/g, " ").trim());
    if (isDocumentTextGone(latestDocumentText, expectedText)) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= settleDelayMs) {
        return { completed: true, latestDocumentText, elapsedMs: Date.now() - startedAt };
      }
    } else {
      absentSince = null;
    }
    await page.waitForTimeout(pollMs);
  }
  return { completed: false, latestDocumentText, elapsedMs: Date.now() - startedAt };
}

async function isTargetDisabled(target) {
  try {
    return await target.evaluate((element) => {
      const disabled = "disabled" in element && Boolean(element.disabled);
      return disabled || element.getAttribute("aria-disabled") === "true";
    });
  } catch {
    return false;
  }
}

export async function executeBrowserAction({
  page,
  action,
  observation,
  turnToken,
  actionHistory = [],
  contextData,
  humanInputs,
  secretValues,
  settleDelayMs,
  settleTimeoutMs,
  logger,
  throwIfInterrupted,
}) {
  const payload = action.payload;

  if (payload.action === "scroll") {
    if (isAlternatingScrollLoop(actionHistory, payload)) {
      throw new Error(`Alternating scroll loop detected in '${payload.containerId}'. Choose a non-scroll action or finish based on current evidence.`);
    }
    const container = observation.scrollContainers.find((candidate) => candidate.id === payload.containerId);
    if (!container) throw new Error(`Planner scroll container '${payload.containerId}' is not in the observation.`);
    if (payload.direction === "down" && !container.canScrollDown) {
      throw new Error(`Planner scroll container '${container.id}' cannot scroll down.`);
    }
    if (payload.direction === "up" && !container.canScrollUp) {
      throw new Error(`Planner scroll container '${container.id}' cannot scroll up.`);
    }

    const scrollContainer = page.locator(`[data-agentic-turn="${turnToken}"][data-agentic-scroll-id="${container.id}"]`).first();
    if ((await scrollContainer.count()) === 0) throw new Error(`Planner scroll container '${container.id}' is no longer available.`);
    const didScroll = await scrollContainer.evaluate((element, direction) => {
      const start = element.scrollTop;
      element.scrollBy({ top: direction === "down" ? Math.max(200, Math.floor(element.clientHeight * 0.8)) : -Math.max(200, Math.floor(element.clientHeight * 0.8)), behavior: "instant" });
      return Math.abs(element.scrollTop - start) > 1;
    }, payload.direction);
    if (!didScroll) throw new Error(`Planner scroll container '${container.id}' did not move.`);
    logger.info(`scrolling ${payload.direction} in ${container.id}`);
    await waitForUiSettle(page, settleDelayMs, settleTimeoutMs);
    return {};
  }

  if (!["click", "fill", "select_option"].includes(payload.action)) {
    throw new Error(`Unsupported browser action: ${payload.action}`);
  }

  const matchedControl = resolveTargetControl(observation.controls, payload.target);
  const target = page.locator(`[data-agentic-turn="${turnToken}"][data-agentic-id="${matchedControl.id}"]`).first();
  if ((await target.count()) === 0) {
    throw new Error(`Planner target disappeared from the DOM: ${describeTarget(payload.target)}`);
  }

  if (payload.action === "click") {
    if (matchedControl.role === "option" && matchedControl.selected) {
      throw new Error(`Selected option before click: ${describeTarget(payload.target)}`);
    }
    if (await isTargetDisabled(target)) throw new Error(`Disabled target before click: ${describeTarget(payload.target)}`);
    logger.info(`clicking target ${describeTarget(payload.target)}`);
    await target.click({ timeout: 1500 });
  } else if (payload.action === "fill") {
    logger.info(`filling target ${describeTarget(payload.target)}`);
    await target.fill(resolveFillValue(payload.value, contextData, humanInputs, secretValues));
  } else {
    if (matchedControl.tag !== "select") throw new Error(`Planner select_option target is not a native select: ${describeTarget(payload.target)}`);
    const option = matchedControl.options?.find((candidate) => candidate.value === payload.value);
    if (!option) throw new Error(`Planner select_option value is not available: ${payload.value}`);
    if (option.disabled) throw new Error(`Planner select_option value is disabled: ${payload.value}`);
    logger.info(`selecting '${option.label || option.value}' in ${describeTarget(payload.target)}`);
    await target.selectOption({ value: payload.value });
  }

  throwIfInterrupted();
  await waitForUiSettle(page, settleDelayMs, settleTimeoutMs);
  return {
    target: {
      label: matchedControl.label,
      ...(matchedControl.ariaLabel ? { ariaLabel: matchedControl.ariaLabel } : {}),
      ...(matchedControl.text ? { text: matchedControl.text } : {}),
      ...(matchedControl.role ? { role: matchedControl.role } : {}),
      ...(matchedControl.type ? { type: matchedControl.type } : {}),
    },
  };
}