import { calculateCostEstimate } from "../utils/scenario/pricing.mjs";
import {
  escapeHtml,
  getSummaryStepUrlParts,
  renderJsonHtml,
  stripAnsi
} from "./report-helpers.mjs";

function renderIcon(name) {
  return `<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
}

function renderTokenUsageHtml(tokenUsage, pricing) {
  if (!tokenUsage) {
    return "";
  }

  const costEstimate = pricing ? calculateCostEstimate(tokenUsage, pricing) : null;
  const tokenFields = [
    ["Input", tokenUsage.inputTokens],
    ["Output", tokenUsage.outputTokens],
    ["Cache Read", tokenUsage.cacheReadInputTokens],
    ["Cache Write", tokenUsage.cacheWriteInputTokens],
    ["Total", tokenUsage.totalTokens]
  ];

  return `<section>
    <h4>Token Usage</h4>
    <div class="token-grid">
      ${tokenFields
        .map(
          ([label, value]) =>
            `<div><span class="field-label">${escapeHtml(label)}</span><strong>${Number(value || 0).toLocaleString()}</strong></div>`
        )
        .join("")}
      ${costEstimate ? `<div><span class="field-label">Estimated Cost</span><strong>${costEstimate.costs.total.toFixed(6)} ${escapeHtml(costEstimate.currency)}</strong></div>` : ""}
    </div>
  </section>`;
}

function renderAgentPromptHtml(agentPrompt) {
  if (!agentPrompt) {
    return "";
  }

  return `<section>
    <h4>Agent Prompt</h4>
    <pre>${escapeHtml(agentPrompt.userText || "")}</pre>
  </section>`;
}

function renderAriaSnapshotHtml(ariaSnapshot) {
  if (!ariaSnapshot) {
    return "";
  }

  return `<section>
    <h4>ARIA Snapshot</h4>
    <pre>${escapeHtml(ariaSnapshot)}</pre>
  </section>`;
}

function renderStepTabs(stepIndex, sections) {
  const availableSections = sections.filter((section) => section.content);
  if (availableSections.length === 0) {
    return "";
  }

  const tabPrefix = `step-${stepIndex}-tab`;
  return `<div class="step-tabs">
    <div class="tab-strip" role="tablist" aria-label="Step ${stepIndex} details" data-step-tabs>
      ${availableSections
        .map(
          (section, index) =>
            `<button type="button" role="tab" id="${tabPrefix}-${section.id}" aria-controls="${tabPrefix}-panel-${section.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? "0" : "-1"}">${escapeHtml(section.label)}</button>`
        )
        .join("")}
    </div>
    ${availableSections
      .map(
        (section, index) =>
          `<div role="tabpanel" id="${tabPrefix}-panel-${section.id}" aria-labelledby="${tabPrefix}-${section.id}"${index === 0 ? "" : " hidden"}>${section.content}</div>`
      )
      .join("")}
  </div>`;
}

function renderObservationHtml(observation, stepIndex) {
  if (!observation) {
    return "";
  }

  const modal = observation.modal || {};
  const headings = Array.isArray(observation.headings) ? observation.headings : [];
  const alerts = Array.isArray(observation.alerts) ? observation.alerts : [];
  const scrollContainers = Array.isArray(observation.scrollContainers)
    ? observation.scrollContainers
    : [];
  const controls = Array.isArray(observation.controls) ? observation.controls : [];

  const renderChipList = (items, emptyLabel) =>
    items.length > 0
      ? `<div class="pill-list">${items.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("")}</div>`
      : `<p class="empty-note">${escapeHtml(emptyLabel)}</p>`;

  const controlCards = controls.length
    ? `<div class="control-grid">${controls
        .map((control) => {
          const titleBits = [control.tag, control.role, control.type]
            .filter(Boolean)
            .map((part) => escapeHtml(part));
          const fieldRows = [
            control.text
              ? `<div><span class="field-label">Text</span><strong>${escapeHtml(control.text)}</strong></div>`
              : "",
            control.label
              ? `<div><span class="field-label">Label</span><strong>${escapeHtml(control.label)}</strong></div>`
              : "",
            control.ariaLabel
              ? `<div><span class="field-label">ARIA</span><strong>${escapeHtml(control.ariaLabel)}</strong></div>`
              : "",
            control.description
              ? `<div><span class="field-label">Description</span><strong>${escapeHtml(control.description)}</strong></div>`
              : "",
            control.contextPath?.length
              ? `<div><span class="field-label">Context</span><strong>${escapeHtml(control.contextPath.join(" > "))}</strong></div>`
              : "",
            control.placeholder
              ? `<div><span class="field-label">Placeholder</span><strong>${escapeHtml(control.placeholder)}</strong></div>`
              : "",
            control.value
              ? `<div><span class="field-label">Value</span><strong>${escapeHtml(control.value)}</strong></div>`
              : ""
          ]
            .filter(Boolean)
            .join("");
          const flags = [
            control.priority ? "priority" : "",
            control.checked ? "checked" : "",
            control.hasValue ? "has value" : "",
            control.required ? "required" : "",
            typeof control.expanded === "boolean"
              ? control.expanded
                ? "expanded"
                : "collapsed"
              : "",
            control.selected ? "selected" : "",
            control.pressed ? "pressed" : "",
            control.current ? `current: ${control.current}` : "",
            control.invalid ? "invalid" : "",
            control.disabled ? "disabled" : ""
          ]
            .filter(Boolean)
            .map((flag) => `<span class="mini-pill">${escapeHtml(flag)}</span>`)
            .join("");

          return `<article class="control-card">
            <div class="control-card-head">
              <span class="control-id">${escapeHtml(control.id || "")}</span>
              <span class="control-kind">${titleBits.join(" · ") || "control"}</span>
            </div>
            ${flags ? `<div class="mini-pill-row">${flags}</div>` : ""}
            <div class="field-grid">${fieldRows || '<div><span class="field-label">Text</span><strong>(empty)</strong></div>'}</div>
          </article>`;
        })
        .join("")}</div>`
    : `<p class="empty-note">No controls captured for this step.</p>`;

  const viewPrefix = `step-${stepIndex}-observation`;
  return `<section class="observation">
    <h4>Observation</h4>
    <div class="observation-mode-toggle" role="group" aria-label="Observation view" data-observation-toggle>
      <button type="button" aria-controls="${viewPrefix}-ui" aria-pressed="true" data-observation-view="ui">UI</button>
      <button type="button" aria-controls="${viewPrefix}-raw" aria-pressed="false" data-observation-view="raw">Raw</button>
    </div>
    <div class="observation-layout" id="${viewPrefix}-ui" data-observation-panel="ui">
      <div class="observation-grid">
        <article class="info-card">
          <span class="field-label">URL</span>
          <strong>${escapeHtml(observation.url || "n/a")}</strong>
        </article>
        <article class="info-card">
          <span class="field-label">Title</span>
          <strong>${escapeHtml(observation.title || "Untitled")}</strong>
        </article>
        <article class="info-card">
          <span class="field-label">Modal</span>
          <strong>${modal.open ? "Open" : "Closed"}</strong>
          <div class="mini-pill-row">
            <span class="mini-pill ${modal.blocksBackground ? "mini-pill-alert" : ""}">${modal.blocksBackground ? "blocks background" : "background accessible"}</span>
            ${modal.role ? `<span class="mini-pill">${escapeHtml(modal.role)}</span>` : ""}
            ${modal.title ? `<span class="mini-pill">${escapeHtml(modal.title)}</span>` : ""}
          </div>
        </article>
        <article class="info-card info-card-wide">
          <span class="field-label">Document Text</span>
          <p class="document-text">${escapeHtml(observation.documentText || "")}</p>
        </article>
      </div>

      <div class="observation-section">
        <span class="field-label">Headings</span>
        ${renderChipList(headings, "No headings captured.")}
      </div>

      <div class="observation-section">
        <span class="field-label">Alerts</span>
        ${renderChipList(alerts, "No alerts captured.")}
      </div>

      <div class="observation-section">
        <span class="field-label">Scroll Containers</span>
        ${renderChipList(
          scrollContainers.map(
            (container) =>
              `${container.id}${container.label ? ` (${container.label})` : ""}: ${container.canScrollUp ? "up" : ""}${container.canScrollUp && container.canScrollDown ? ", " : ""}${container.canScrollDown ? "down" : ""}`
          ),
          "No scrollable content in the active scope."
        )}
      </div>

      <div class="observation-section">
        <span class="field-label">Controls (${controls.length})</span>
        ${controlCards}
      </div>

    </div>
    <div class="raw-observation" id="${viewPrefix}-raw" data-observation-panel="raw" hidden>
      ${renderJsonHtml(observation)}
    </div>
  </section>`;
}

export const reportGenerator = {
  id: "html",
  outputFileName: "summary.html",
  render({ report, context }) {
    const { runId, scenario, screenshots, modelSummary, config } = context;
    const agentSystemPrompt =
      report.agentSystemPrompt ||
      report.steps.find((step) => step.agentPrompt?.systemText)?.agentPrompt.systemText;
    const costSummary = report.costEstimate
      ? `
      <section class="card meta-grid">
        <div><span class="meta-label">Input</span><strong>${report.costEstimate.costs.input.toFixed(6)} ${escapeHtml(report.costEstimate.currency)}</strong></div>
        <div><span class="meta-label">Output</span><strong>${report.costEstimate.costs.output.toFixed(6)} ${escapeHtml(report.costEstimate.currency)}</strong></div>
        <div><span class="meta-label">Cache Read</span><strong>${report.costEstimate.costs.cacheRead.toFixed(6)} ${escapeHtml(report.costEstimate.currency)}</strong></div>
        <div><span class="meta-label">Cache Write</span><strong>${report.costEstimate.costs.cacheWrite.toFixed(6)} ${escapeHtml(report.costEstimate.currency)}</strong></div>
        <div><span class="meta-label">Total</span><strong>${report.costEstimate.costs.total.toFixed(6)} ${escapeHtml(report.costEstimate.currency)}</strong></div>
      </section>`
      : "";

    const stepsHtml = report.steps
      .map((step) => {
        const planner = step.plannerAction
          ? `${escapeHtml(step.plannerAction.payload.action)}${step.plannerAction.payload.target ? ` target=${escapeHtml(JSON.stringify(step.plannerAction.payload.target))}` : ""}`
          : escapeHtml(step.name);
        const reason = step.plannerAction?.reason ? escapeHtml(step.plannerAction.reason) : "";
        const stepUrl = getSummaryStepUrlParts(step.url, config.baseUrl);
        const screenshotLink = step.screenshot
          ? `<a class="chip" href="${escapeHtml(step.screenshot)}">${renderIcon("image")}<span>Open screenshot</span></a>`
          : "";
        const htmlLink = step.html
          ? `<a class="chip" href="${escapeHtml(step.html)}">${renderIcon("code-2")}<span>Page HTML</span></a>`
          : "";
        const liveUrlLink = stepUrl.href
          ? `<a class="chip" href="${escapeHtml(stepUrl.href)}">${renderIcon("external-link")}<span>Open ${escapeHtml(stepUrl.label)}</span></a>`
          : "";
        const screenshotPreview = step.screenshot
          ? `<a class="image-link" href="${escapeHtml(step.screenshot)}"><img src="${escapeHtml(step.screenshot)}" alt="Screenshot for step ${step.index}"></a>`
          : "";
        const observationBlock = step.observation
          ? renderObservationHtml(step.observation, step.index)
          : "";
        const plannerActionBlock = step.plannerAction
          ? `<section><h4>Planner Action</h4>${renderJsonHtml(step.plannerAction)}</section>`
          : "";
        const screenshotBlock = screenshotPreview
          ? `<section><h4>Resulting Screenshot</h4>${screenshotPreview}</section>`
          : "";
        const agentPromptBlock = renderAgentPromptHtml(step.agentPrompt);
        const ariaSnapshotBlock = renderAriaSnapshotHtml(step.ariaSnapshot);
        const tokenBlock = renderTokenUsageHtml(step.plannerTokenUsage, report.pricing);
        const errorBlock = step.error
          ? `<section><h4>Step Error</h4><pre>${escapeHtml(stripAnsi(step.error))}</pre></section>`
          : "";
        const stepTabs = renderStepTabs(step.index, [
          { id: "action", label: "Planner Action", content: plannerActionBlock },
          { id: "screenshot", label: "Resulting Screenshot", content: screenshotBlock },
          { id: "observation", label: "Observation", content: observationBlock },
          { id: "aria-snapshot", label: "ARIA Snapshot", content: ariaSnapshotBlock },
          { id: "prompt", label: "Agent Prompt", content: agentPromptBlock },
          { id: "tokens", label: "Token Usage", content: tokenBlock },
          { id: "error", label: "Step Error", content: errorBlock }
        ]);

        return `
        <details class="step-card" id="step-${step.index}">
          <summary>
            <div class="step-summary">
              <span class="step-caret" aria-hidden="true"></span>
              <span class="step-index">${step.index}.</span>
              <a class="step-anchor" href="#step-${step.index}" aria-label="Link to step ${step.index}">${renderIcon("link")}</a>
              <span class="step-action">${planner}</span>
              <span class="step-url">${stepUrl.href ? `<a href="${escapeHtml(stepUrl.href)}">${escapeHtml(stepUrl.label)}</a>` : escapeHtml(stepUrl.label)}</span>
              <span class="step-duration">${step.durationMs}ms</span>
              ${reason ? `<span class="step-reason">${reason}</span>` : ""}
            </div>
          </summary>
          <div class="step-body">
            <div class="chip-row">${liveUrlLink}${screenshotLink}${htmlLink}</div>
            ${stepTabs}
          </div>
        </details>`;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dublo Run ${escapeHtml(runId)}</title>
    <style>
      :root { color-scheme: light dark; --bg: #f1f3ee; --surface: #ffffff; --surface-muted: #f8faf7; --code-surface: #f4f6f2; --ink: #17221f; --muted: #5e6c66; --line: #cbd4cd; --accent: #08756b; --accent-soft: #d6efe8; --error: #a32929; --error-soft: #fde5e2; --shadow: 0 12px 30px rgba(20, 37, 30, 0.08); }
      @media (prefers-color-scheme: dark) { :root { --bg: #121917; --surface: #1b2521; --surface-muted: #202c27; --code-surface: #101714; --ink: #e7efe9; --muted: #b4c2ba; --line: #405147; --accent: #6dd6c7; --accent-soft: #16483f; --error: #ff9b91; --error-soft: #542b2b; --shadow: 0 16px 36px rgba(0, 0, 0, 0.28); } }
      * { box-sizing: border-box; min-width: 0; }
      body { margin: 0; min-width: 320px; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
      main { width: calc(100% - 48px); margin: 0 auto; padding: 32px 0 56px; }
      .hero, .card, .step-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
      .hero { padding: 24px; margin-bottom: 20px; }
      h1, h2, h3, h4 { margin: 0 0 12px; }
      h1 { font-size: 2rem; }
      h2 { margin-top: 24px; font-size: 1.25rem; }
      h4 { font-size: 0.95rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .status-row, .meta-grid { display: grid; gap: 12px; }
      .status-row { grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); margin-top: 18px; }
      .meta-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 165px), 1fr)); padding: 18px 20px; margin-bottom: 20px; }
      .meta-label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.04em; }
      .status-row strong, .meta-grid strong, .field-grid strong, .info-card strong, .document-text, .step-reason, .step-url, .control-kind { overflow-wrap: anywhere; word-break: break-word; }
      .badge { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; font-size: 0.85rem; font-weight: 700; background: var(--accent-soft); color: var(--accent); }
      .badge.failed { background: var(--error-soft); color: var(--error); }
      .prompt, .error-card { padding: 20px; margin-bottom: 20px; }
      .system-prompt summary { cursor: pointer; }
      .system-prompt summary h2 { display: inline; margin: 0; }
      .steps { display: grid; gap: 14px; min-width: 0; }
      .step-card { min-width: 0; max-width: 100%; }
      .step-card summary { min-width: 0; max-width: 100%; list-style: none; cursor: pointer; padding: 18px 20px; }
      .step-card summary::-webkit-details-marker { display: none; }
      .step-summary { display: grid; min-width: 0; max-width: 100%; gap: 8px 14px; grid-template-columns: auto auto auto minmax(0, 1fr) minmax(120px, auto) auto; align-items: center; }
      .step-caret { width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 6px solid var(--muted); transition: transform 160ms ease; }
      .step-card[open] .step-caret { transform: rotate(90deg); }
      .step-index { font-weight: 700; color: var(--accent); }
      .step-anchor { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
      .step-anchor:hover { color: var(--accent); }
      .step-anchor:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .step-action { min-width: 0; max-width: 100%; overflow-wrap: anywhere; font-weight: 700; }
      .step-url, .step-duration, .step-reason { color: var(--muted); font-size: 0.95rem; }
      .step-duration { justify-self: end; white-space: nowrap; }
      .step-reason { grid-column: 1 / -1; line-height: 1.45; }
      .step-url a, a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .step-body { border-top: 1px solid var(--line); padding: 18px 20px 20px; }
      .chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .chip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 7px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface-muted); overflow-wrap: anywhere; }
      .icon { width: 1em; height: 1em; flex: 0 0 auto; stroke-width: 2; }
      .icon-sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
      .image-link img { display: block; width: auto; max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); }
      .step-tabs { display: grid; gap: 16px; }
      .step-tabs [role="tabpanel"] { min-width: 0; max-width: 100%; }
      .step-tabs [role="tabpanel"] pre { min-width: 0; max-width: 100%; overflow-x: auto; }
      .tab-strip { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--line); }
      .tab-strip button { flex: 0 0 auto; border: 0; border-bottom: 3px solid transparent; background: transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 0.88rem; font-weight: 700; padding: 9px 12px 8px; }
      .tab-strip button[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); }
      .tab-strip button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .token-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr)); padding: 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-muted); }
      .observation-mode-toggle { display: inline-flex; max-width: 100%; margin-bottom: 14px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
      .observation-mode-toggle button { border: 0; border-right: 1px solid var(--line); background: var(--surface); color: var(--muted); cursor: pointer; font: inherit; font-size: 0.85rem; font-weight: 700; padding: 7px 11px; }
      .observation-mode-toggle button:last-child { border-right: 0; }
      .observation-mode-toggle button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
      .observation-mode-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .observation [hidden] { display: none !important; }
      .observation-layout { display: grid; gap: 14px; }
      .observation-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); }
      .info-card { padding: 14px; border-radius: 6px; background: var(--surface-muted); border: 1px solid var(--line); }
      .info-card-wide { grid-column: 1 / -1; }
      .observation-section { padding: 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); }
      .pill-list, .mini-pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .pill, .mini-pill { display: inline-flex; align-items: center; max-width: 100%; overflow-wrap: anywhere; border-radius: 999px; background: var(--surface-muted); border: 1px solid var(--line); color: var(--ink); }
      .pill { padding: 8px 12px; }
      .mini-pill { padding: 5px 9px; font-size: 0.82rem; }
      .mini-pill-alert { background: var(--error-soft); border-color: var(--error); color: var(--error); }
      .empty-note, .document-text { margin: 0; color: var(--muted); line-height: 1.5; }
      .control-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
      .control-card { padding: 14px; border-radius: 6px; background: var(--surface-muted); border: 1px solid var(--line); }
      .control-card-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
      .control-id { font-weight: 800; color: var(--accent); }
      .control-kind { color: var(--muted); font-size: 0.9rem; text-align: right; }
      .field-grid { display: grid; gap: 10px; }
      .field-label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; }
      .raw-observation { min-width: 0; max-width: 100%; }
      .raw-observation pre { min-width: 0; max-width: 100%; overflow-x: auto; }
      pre { margin: 0; padding: 14px; overflow: auto; border-radius: 6px; background: var(--code-surface); border: 1px solid var(--line); color: var(--ink); font-size: 0.9rem; line-height: 1.45; }
      @media (max-width: 860px) { main { width: calc(100% - 32px); padding-top: 16px; } .hero { padding: 18px; } .step-summary { grid-template-columns: auto auto auto minmax(0, 1fr); } .step-url, .step-duration { grid-column: 4; justify-self: start; } .step-reason { grid-column: 1 / -1; } }
      @media (max-width: 520px) { main { width: calc(100% - 24px); } .hero, .prompt, .error-card { padding: 16px; } .step-card summary, .step-body { padding-left: 14px; padding-right: 14px; } .status-row, .meta-grid { grid-template-columns: 1fr; } h1 { font-size: 1.55rem; } }
    </style>
  </head>
  <body>
    <svg class="icon-sprite" aria-hidden="true" focusable="false">
      <symbol id="icon-external-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></symbol>
      <symbol id="icon-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07.07l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.07-.07l-3 3A5 5 0 0 0 11 21l1.71-1.71"></path></symbol>
      <symbol id="icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></symbol>
      <symbol id="icon-code-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path></symbol>
    </svg>
    <main>
      <section class="hero">
        <span class="badge ${escapeHtml(report.status)}">${escapeHtml(report.status.toUpperCase())}</span>
        <h1>Agentic Scenario Report</h1>
        <div class="status-row">
          <div><span class="meta-label">Provider/Model</span><strong>${escapeHtml(modelSummary)}</strong></div>
          <div><span class="meta-label">Final URL</span><strong>${escapeHtml(report.finalUrl || "n/a")}</strong></div>
          <div><span class="meta-label">Run ID</span><strong>${escapeHtml(runId)}</strong></div>
          <div><span class="meta-label">Screenshots</span><strong>${escapeHtml(screenshots)}</strong></div>
        </div>
      </section>
      ${costSummary}
      <section class="card prompt"><h2>Test Prompt</h2><p>${escapeHtml(scenario)}</p></section>
      ${agentSystemPrompt ? `<details class="card prompt system-prompt"><summary><h2>Agent System Prompt</h2></summary><pre>${escapeHtml(agentSystemPrompt)}</pre></details>` : ""}
      <section><h2>Steps</h2><div class="steps">${stepsHtml}</div></section>
      ${report.error ? `<section class="card error-card"><h2>Error</h2><pre>${escapeHtml(stripAnsi(report.error))}</pre></section>` : ""}
    </main>
    <script>
      document.querySelectorAll("[data-step-tabs]").forEach(function (tabList) {
        const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
        const activateTab = function (tab) {
          tabs.forEach(function (candidate) {
            const selected = candidate === tab;
            candidate.setAttribute("aria-selected", String(selected));
            candidate.tabIndex = selected ? 0 : -1;
            document.getElementById(candidate.getAttribute("aria-controls")).hidden = !selected;
          });
        };

        tabs.forEach(function (tab, index) {
          tab.addEventListener("click", function () {
            activateTab(tab);
          });
          tab.addEventListener("keydown", function (event) {
            let nextIndex = index;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = tabs.length - 1;
            else return;
            event.preventDefault();
            tabs[nextIndex].focus();
            activateTab(tabs[nextIndex]);
          });
        });
      });
      document.querySelectorAll("[data-observation-toggle]").forEach(function (toggle) {
        const buttons = Array.from(toggle.querySelectorAll("button"));
        buttons.forEach(function (button) {
          button.addEventListener("click", function () {
            const selectedView = button.dataset.observationView;
            buttons.forEach(function (candidate) {
              const selected = candidate === button;
              candidate.setAttribute("aria-pressed", String(selected));
              document.getElementById(candidate.getAttribute("aria-controls")).hidden = !selected;
            });
            toggle.dataset.observationView = selectedView;
          });
        });
      });
    </script>
  </body>
</html>`;
  }
};
