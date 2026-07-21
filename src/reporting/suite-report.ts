import path from "node:path";
import type { SuiteResult, TaskResult } from "../utils/suite-runner.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function statusBadge(status: TaskResult["status"]): string {
  const classes: Record<TaskResult["status"], string> = {
    passed: "badge-pass",
    failed: "badge-fail",
    error: "badge-error"
  };
  const labels: Record<TaskResult["status"], string> = {
    passed: "PASS",
    failed: "FAIL",
    error: "ERROR"
  };
  return `<span class="badge ${classes[status]}">${labels[status]}</span>`;
}

function renderContextList(context: string[]): string {
  if (context.length === 0) return '<span class="muted">—</span>';
  return context.map((c) => `<code>${escapeHtml(c)}</code>`).join(" + ");
}

function relativeLinkTo(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, "/");
}

export function renderSuiteReportHtml(result: SuiteResult): string {
  const startedAt = new Date(result.startedAt);
  const finishedAt = new Date(result.finishedAt);
  const totalMs = finishedAt.getTime() - startedAt.getTime();
  const passRate = result.total > 0 ? Math.round((result.passed / result.total) * 100) : 0;
  const tokenSummary = result.tokenUsage
    ? `<span><strong>Tokens:</strong> ${result.tokenUsage.totalTokens.toLocaleString()} across ${result.tokenUsage.plannerCalls.toLocaleString()} planner calls</span>`
    : "";
  const costSummary = result.costTotals
    ?.map((cost) => `<span><strong>Estimated cost:</strong> ${cost.total.toFixed(6)} ${escapeHtml(cost.currency)}</span>`)
    .join("") ?? "";

  const taskRows = result.tasks
    .map((task) => {
      const htmlLink = task.summaryHtmlPath
        ? `<a href="${escapeHtml(relativeLinkTo(result.suiteDir, task.summaryHtmlPath))}">report</a>`
        : task.reportPath
          ? `<a href="${escapeHtml(relativeLinkTo(result.suiteDir, path.dirname(task.reportPath)))}">dir</a>`
          : "—";

      const errorNote = task.errorMessage
        ? `<div class="error-note">${escapeHtml(task.errorMessage.slice(0, 200))}</div>`
        : "";

      return `
      <tr class="row-${task.status}">
        <td class="col-num">${task.index + 1}</td>
        <td class="col-scenario"><code>${escapeHtml(task.scenario)}</code></td>
        <td class="col-context">${renderContextList(task.context)}</td>
        <td class="col-status">${statusBadge(task.status)}</td>
        <td class="col-duration">${escapeHtml(formatDuration(task.durationMs))}</td>
        <td class="col-report">${htmlLink}${errorNote}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dublo Suite Report — ${escapeHtml(result.suiteId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; line-height: 1.5; padding: 2rem; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.75rem; }
  .meta { color: #555; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .meta span { margin-right: 1.5rem; }
  .summary-bar { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .summary-card { background: #fff; border-radius: 8px; padding: 1rem 1.5rem; min-width: 100px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .summary-card .num { font-size: 2rem; font-weight: 700; line-height: 1; }
  .summary-card .lbl { font-size: 0.75rem; color: #777; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.25rem; }
  .num-pass { color: #16a34a; }
  .num-fail { color: #dc2626; }
  .num-error { color: #d97706; }
  .num-total { color: #1a1a2e; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  th { background: #f1f3f5; text-align: left; padding: 0.6rem 0.75rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #444; border-bottom: 2px solid #e2e8f0; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #e9ecef; font-size: 0.875rem; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .row-passed { background: #f0fdf4; }
  .row-failed { background: #fff5f5; }
  .row-error  { background: #fffbeb; }
  .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; }
  .badge-pass  { background: #dcfce7; color: #16a34a; }
  .badge-fail  { background: #fee2e2; color: #dc2626; }
  .badge-error { background: #fef3c7; color: #d97706; }
  .col-num { width: 3rem; color: #888; }
  .col-status { width: 6rem; }
  .col-duration { width: 7rem; color: #555; }
  .col-report { width: 6rem; }
  code { background: #f1f3f5; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.8rem; }
  .muted { color: #aaa; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .error-note { font-size: 0.75rem; color: #b45309; margin-top: 0.3rem; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>Dublo Suite Report</h1>
<div class="meta">
  <span><strong>Suite:</strong> ${escapeHtml(result.suiteId)}</span>
  <span><strong>Started:</strong> ${escapeHtml(startedAt.toLocaleString())}</span>
  <span><strong>Duration:</strong> ${escapeHtml(formatDuration(totalMs))}</span>
  <span><strong>Concurrency:</strong> ${result.concurrency}</span>
  <span><strong>Pass rate:</strong> ${passRate}%</span>
  ${tokenSummary}
  ${costSummary}
</div>
<div class="summary-bar">
  <div class="summary-card"><div class="num num-pass">${result.passed}</div><div class="lbl">Passed</div></div>
  <div class="summary-card"><div class="num num-fail">${result.failed}</div><div class="lbl">Failed</div></div>
  <div class="summary-card"><div class="num num-error">${result.errored}</div><div class="lbl">Error</div></div>
  <div class="summary-card"><div class="num num-total">${result.total}</div><div class="lbl">Total</div></div>
</div>
<h2>Tasks</h2>
<table>
<thead>
  <tr>
    <th class="col-num">#</th>
    <th class="col-scenario">Scenario</th>
    <th class="col-context">Context</th>
    <th class="col-status">Status</th>
    <th class="col-duration">Duration</th>
    <th class="col-report">Report</th>
  </tr>
</thead>
<tbody>
${taskRows}
</tbody>
</table>
</body>
</html>`;
}

export function renderSuiteReportMarkdown(result: SuiteResult): string {
  const startedAt = new Date(result.startedAt);
  const finishedAt = new Date(result.finishedAt);
  const totalMs = finishedAt.getTime() - startedAt.getTime();
  const passRate = result.total > 0 ? Math.round((result.passed / result.total) * 100) : 0;
  const metricLines = [
    ...(result.tokenUsage
      ? [`- **Tokens:** ${result.tokenUsage.totalTokens.toLocaleString()} across ${result.tokenUsage.plannerCalls.toLocaleString()} planner calls`]
      : []),
    ...(result.costTotals ?? []).map(
      (cost) => `- **Estimated Cost:** ${cost.total.toFixed(6)} ${cost.currency}`
    )
  ];

  const taskLines = result.tasks.map((task) => {
    const status =
      task.status === "passed" ? "✅ PASS" : task.status === "failed" ? "❌ FAIL" : "⚠️ ERROR";
    const ctx = task.context.length > 0 ? task.context.join("+") : "—";
    const duration = formatDuration(task.durationMs);
    const reportRef = task.summaryHtmlPath
      ? `[report](${relativeLinkTo(result.suiteDir, task.summaryHtmlPath)})`
      : task.reportPath
        ? `[dir](${relativeLinkTo(result.suiteDir, path.dirname(task.reportPath))})`
        : "—";
    const errorNote = task.errorMessage ? ` · \`${task.errorMessage.split("\n")[0] ?? ""}\`` : "";
    return `| ${task.index + 1} | \`${task.scenario}\` | ${ctx} | ${status} | ${duration} | ${reportRef}${errorNote} |`;
  });

  return [
    "# Dublo Suite Report",
    "",
    `- **Suite ID:** ${result.suiteId}`,
    `- **Started:** ${startedAt.toISOString()}`,
    `- **Finished:** ${finishedAt.toISOString()}`,
    `- **Duration:** ${formatDuration(totalMs)}`,
    `- **Concurrency:** ${result.concurrency}`,
    `- **Result:** ${result.passed} passed / ${result.failed} failed / ${result.errored} errored (${passRate}% pass rate)`,
    ...metricLines,
    "",
    "## Tasks",
    "",
    "| # | Scenario | Context | Status | Duration | Report |",
    "|---|----------|---------|--------|----------|--------|",
    ...taskLines
  ].join("\n");
}
