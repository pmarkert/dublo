import { formatSummaryStepUrl, stripAnsi } from "./report-helpers.mjs";

export const reportGenerator = {
  id: "markdown",
  outputFileName: "summary.md",
  render({ report, context }) {
    const { runId, scenario, screenshots, modelSummary, config } = context;
    const displayError = report.error ? stripAnsi(report.error) : "";

    return [
      "# Agentic Scenario (LLM-Driven)",
      "",
      `- Status: ${report.status}`,
      `- Provider/Model: ${modelSummary}`,
      `- Final URL: ${report.finalUrl || "n/a"}`,
      `- Run ID: ${runId}`,
      `- Screenshots: ${screenshots}`,
      ...(report.costEstimate
        ? [`- Estimated Cost (${report.costEstimate.currency}): ${report.costEstimate.costs.total.toFixed(6)}`]
        : []),
      "",
      ...(report.costEstimate
        ? [
            "## Cost Estimate",
            `- Input: ${report.costEstimate.costs.input.toFixed(6)} ${report.costEstimate.currency}`,
            `- Output: ${report.costEstimate.costs.output.toFixed(6)} ${report.costEstimate.currency}`,
            `- Cache Read: ${report.costEstimate.costs.cacheRead.toFixed(6)} ${report.costEstimate.currency}`,
            `- Cache Write: ${report.costEstimate.costs.cacheWrite.toFixed(6)} ${report.costEstimate.currency}`,
            `- Total: ${report.costEstimate.costs.total.toFixed(6)} ${report.costEstimate.currency}`,
            "",
          ]
        : []),
      "## Test Prompt",
      scenario,
      "",
      "## Steps",
      ...report.steps.map((step) => {
        const planner = step.plannerAction
          ? ` action=${step.plannerAction.payload.action}${step.plannerAction.payload.target ? ` target=${JSON.stringify(step.plannerAction.payload.target)}` : ""}`
          : "";
        const stepUrlPart = formatSummaryStepUrl(step.url, config.baseUrl);
        const screenshotPart = step.screenshot ? ` [${step.screenshot}](${step.screenshot})` : "";
        const htmlPart = step.html ? ` [${step.html}](${step.html})` : "";
        return `- ${step.index}. ${step.name} (${step.durationMs}ms)${planner} -> ${stepUrlPart}${screenshotPart}${htmlPart}`;
      }),
      "",
      displayError ? `## Error\n\n\`\`\`text\n${displayError}\n\`\`\`` : "## Result\n\nScenario objective completed.",
    ].join("\n");
  },
};