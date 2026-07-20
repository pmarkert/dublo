import { escapeHtml, getSummaryStepUrlParts, renderJsonHtml, stripAnsi } from "./report-helpers.mjs";

function renderObservationHtml(observation) {
  if (!observation) {
    return "";
  }

  const modal = observation.modal || {};
  const headings = Array.isArray(observation.headings) ? observation.headings : [];
  const alerts = Array.isArray(observation.alerts) ? observation.alerts : [];
  const controls = Array.isArray(observation.controls) ? observation.controls : [];

  const renderChipList = (items, emptyLabel) =>
    items.length > 0
      ? `<div class="pill-list">${items.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("")}</div>`
      : `<p class="empty-note">${escapeHtml(emptyLabel)}</p>`;

  const controlCards = controls.length
    ? `<div class="control-grid">${controls
        .map((control) => {
          const titleBits = [control.tag, control.role, control.type].filter(Boolean).map((part) => escapeHtml(part));
          const fieldRows = [
            control.text ? `<div><span class="field-label">Text</span><strong>${escapeHtml(control.text)}</strong></div>` : "",
            control.label ? `<div><span class="field-label">Label</span><strong>${escapeHtml(control.label)}</strong></div>` : "",
            control.ariaLabel ? `<div><span class="field-label">ARIA</span><strong>${escapeHtml(control.ariaLabel)}</strong></div>` : "",
            control.placeholder ? `<div><span class="field-label">Placeholder</span><strong>${escapeHtml(control.placeholder)}</strong></div>` : "",
            control.value ? `<div><span class="field-label">Value</span><strong>${escapeHtml(control.value)}</strong></div>` : "",
          ]
            .filter(Boolean)
            .join("");
          const flags = [
            control.priority ? "priority" : "",
            control.checked ? "checked" : "",
            control.hasValue ? "has value" : "",
            control.disabled ? "disabled" : "",
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

  return `<section>
    <h4>Observation</h4>
    <div class="observation-layout">
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
        <span class="field-label">Controls (${controls.length})</span>
        ${controlCards}
      </div>

      <details class="raw-json-toggle">
        <summary>Raw observation JSON</summary>
        ${renderJsonHtml(observation)}
      </details>
    </div>
  </section>`;
}

export const reportGenerator = {
  id: "html",
  outputFileName: "summary.html",
  render({ report, context }) {
    const { runId, scenario, screenshots, modelSummary, config } = context;
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
          ? `${escapeHtml(step.plannerAction.action)}${step.plannerAction.targetId ? ` target=${escapeHtml(step.plannerAction.targetId)}` : ""}`
          : escapeHtml(step.name);
        const reason = step.plannerAction?.reason ? escapeHtml(step.plannerAction.reason) : "";
        const stepUrl = getSummaryStepUrlParts(step.url, config.baseUrl);
        const screenshotLink = step.screenshot ? `<a class="chip" href="${escapeHtml(step.screenshot)}">Screenshot</a>` : "";
        const htmlLink = step.html ? `<a class="chip" href="${escapeHtml(step.html)}">Page HTML</a>` : "";
        const liveUrlLink = stepUrl.href ? `<a class="chip" href="${escapeHtml(stepUrl.href)}">Open ${escapeHtml(stepUrl.label)}</a>` : "";
        const screenshotPreview = step.screenshot
          ? `<a class="image-link" href="${escapeHtml(step.screenshot)}"><img src="${escapeHtml(step.screenshot)}" alt="Screenshot for step ${step.index}"></a>`
          : "";
        const observationBlock = step.observation ? renderObservationHtml(step.observation) : "";
        const plannerActionBlock = step.plannerAction ? `<section><h4>Planner Action</h4>${renderJsonHtml(step.plannerAction)}</section>` : "";
        const inputsBlock = step.knownHumanInputs && Object.keys(step.knownHumanInputs).length > 0
          ? `<section><h4>Known Human Inputs</h4>${renderJsonHtml(step.knownHumanInputs)}</section>`
          : "";
        const tokenBlock = step.plannerTokenUsage ? `<section><h4>Planner Token Usage</h4>${renderJsonHtml(step.plannerTokenUsage)}</section>` : "";
        const errorBlock = step.error ? `<section><h4>Step Error</h4><pre>${escapeHtml(stripAnsi(step.error))}</pre></section>` : "";

        return `
        <details class="step-card">
          <summary>
            <div class="step-summary">
              <span class="step-index">${step.index}.</span>
              <span class="step-action">${planner}</span>
              <span class="step-url">${stepUrl.href ? `<a href="${escapeHtml(stepUrl.href)}">${escapeHtml(stepUrl.label)}</a>` : escapeHtml(stepUrl.label)}</span>
              <span class="step-duration">${step.durationMs}ms</span>
              ${reason ? `<span class="step-reason">${reason}</span>` : ""}
            </div>
          </summary>
          <div class="step-body">
            <div class="chip-row">${liveUrlLink}${screenshotLink}${htmlLink}</div>
            ${screenshotPreview ? `<section><h4>Screenshot</h4>${screenshotPreview}</section>` : ""}
            ${plannerActionBlock}
            ${observationBlock}
            ${inputsBlock}
            ${tokenBlock}
            ${errorBlock}
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
      :root { color-scheme: light; --bg: #f6f1e8; --card: #fffdf9; --ink: #1f2933; --muted: #6b7280; --line: #ddd2bf; --accent: #0f766e; --accent-soft: #d7f0eb; --error: #8a1c1c; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(180deg, #f8f3eb 0%, var(--bg) 100%); color: var(--ink); }
      main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 48px; }
      .hero, .card, .step-card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 10px 30px rgba(31, 41, 51, 0.07); }
      .hero { padding: 24px; margin-bottom: 20px; }
      h1, h2, h3, h4 { margin: 0 0 12px; }
      h1 { font-size: 2rem; }
      h2 { margin-top: 24px; font-size: 1.25rem; }
      h4 { font-size: 0.95rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .status-row, .meta-grid { display: grid; gap: 12px; }
      .status-row { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-top: 18px; }
      .meta-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); padding: 18px 20px; margin-bottom: 20px; }
      .meta-label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.04em; }
      .badge { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; font-size: 0.85rem; font-weight: 700; background: var(--accent-soft); color: var(--accent); }
      .badge.failed { background: #fce7e7; color: var(--error); }
      .prompt, .error-card { padding: 20px; margin-bottom: 20px; }
      .steps { display: grid; gap: 14px; min-width: 0; }
      .step-card { min-width: 0; max-width: 100%; }
      .step-card summary { min-width: 0; max-width: 100%; list-style: none; cursor: pointer; padding: 18px 20px; }
      .step-card summary::-webkit-details-marker { display: none; }
      .step-summary { display: grid; min-width: 0; max-width: 100%; gap: 8px; grid-template-columns: auto minmax(0, 1fr) minmax(120px, auto) auto; align-items: center; }
      .step-index { font-weight: 700; color: var(--accent); }
      .step-action { min-width: 0; max-width: 100%; overflow-x: auto; font-weight: 700; white-space: nowrap; }
      .step-url, .step-duration, .step-reason { color: var(--muted); font-size: 0.95rem; }
      .step-duration { justify-self: end; white-space: nowrap; }
      .step-reason { grid-column: 1 / -1; line-height: 1.45; }
      .step-url a, a { color: var(--accent); text-decoration: none; }
      .step-body { border-top: 1px solid var(--line); padding: 18px 20px 20px; }
      .chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .chip { display: inline-flex; padding: 7px 11px; border-radius: 999px; border: 1px solid var(--line); background: #fff; }
      .image-link img { display: block; width: 100%; max-width: 920px; border-radius: 14px; border: 1px solid var(--line); }
      .observation-layout { display: grid; gap: 14px; }
      .observation-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .info-card { padding: 14px; border-radius: 14px; background: #fffcf7; border: 1px solid #ece2d1; }
      .info-card-wide { grid-column: 1 / -1; }
      .observation-section { padding: 14px; border-radius: 14px; background: #fff; border: 1px solid #ece2d1; }
      .pill-list, .mini-pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .pill, .mini-pill { display: inline-flex; align-items: center; border-radius: 999px; background: #f2efe8; border: 1px solid #e4d9c8; color: var(--ink); }
      .pill { padding: 8px 12px; }
      .mini-pill { padding: 5px 9px; font-size: 0.82rem; }
      .mini-pill-alert { background: #fce7e7; border-color: #efc3c3; color: var(--error); }
      .empty-note, .document-text { margin: 0; color: var(--muted); line-height: 1.5; }
      .control-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .control-card { padding: 14px; border-radius: 14px; background: #fffcf7; border: 1px solid #ece2d1; }
      .control-card-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
      .control-id { font-weight: 800; color: var(--accent); }
      .control-kind { color: var(--muted); font-size: 0.9rem; text-align: right; }
      .field-grid { display: grid; gap: 10px; }
      .field-label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; }
      .raw-json-toggle { min-width: 0; max-width: 100%; overflow: hidden; border: 1px solid #ece2d1; border-radius: 14px; background: #fff; padding: 12px 14px; }
      .raw-json-toggle summary { cursor: pointer; font-weight: 700; color: var(--accent); margin-bottom: 12px; }
      .raw-json-toggle pre { min-width: 0; max-width: 100%; overflow-x: auto; }
      pre { margin: 0; padding: 14px; overflow: auto; border-radius: 12px; background: #f7f7f7; border: 1px solid #ece7dc; font-size: 0.9rem; line-height: 1.45; }
      @media (max-width: 860px) { .step-summary { grid-template-columns: auto 1fr; } .step-url, .step-duration { grid-column: 2; justify-self: start; } }
    </style>
  </head>
  <body>
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
      <section><h2>Steps</h2><div class="steps">${stepsHtml}</div></section>
      ${report.error ? `<section class="card error-card"><h2>Error</h2><pre>${escapeHtml(stripAnsi(report.error))}</pre></section>` : ""}
    </main>
  </body>
</html>`;
  },
};