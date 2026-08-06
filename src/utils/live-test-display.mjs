import process from "node:process";

function clip(value, limit) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function summarizeObservation(observation, limit) {
  if (!observation) return ["No observation collected yet."];

  const labels = [];
  let activeDialog = "";
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (node.kind === "dialog" && node.blocking && !activeDialog) {
        activeDialog = node.title || "Dialog";
      }
      if (node.kind === "heading" && node.text) labels.push(node.text);
      if (node.kind === "control") {
        const label = node.label || node.ariaLabel || node.text;
        if (label) labels.push(label);
      }
      visit(node.children);
    }
  };
  visit(observation.tree);

  const lines = [
    `Title: ${clip(observation.title, limit - 9)}`,
    `URL: ${clip(observation.url, limit - 7)}`
  ];
  if (activeDialog) lines.push(`Dialog: ${clip(activeDialog, limit - 10)}`);
  if (labels.length > 0) {
    lines.push(`Visible: ${clip(labels.slice(0, 5).join(" | "), limit - 11)}`);
  }
  return lines;
}

function formatAction(action, limit) {
  if (!action) return "Waiting for planner response.";
  const payload = action.payload || {};
  const target = payload.target?.id || payload.containerId || "";
  const details = target ? `${payload.action} ${target}` : payload.action || "Unknown action";
  const reason = action.reason ? ` - ${action.reason}` : "";
  return clip(`${details}${reason}`, limit);
}

export function createLiveTestDisplay(options = {}) {
  const output = options.output ?? process.stdout;
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? Boolean(output.isTTY);
  const state = {
    action: undefined,
    baseUrl: "",
    maxSteps: 0,
    objective: "",
    observation: undefined,
    provider: "",
    startedAt: null,
    status: "Preparing test",
    step: 0,
    terminalStatus: "RUNNING"
  };

  const render = () => {
    if (!enabled || state.startedAt === null) return;
    const width = Math.max(60, Number(output.columns) || 100);
    const contentWidth = width - 2;
    const lines = [
      `DUBLO TEST  ${state.terminalStatus}`,
      "-".repeat(contentWidth),
      `Test: ${clip(state.objective, contentWidth - 6)}`,
      `Target: ${clip(state.baseUrl, contentWidth - 8)}`,
      `Model: ${clip(state.provider, contentWidth - 7)}`,
      `Planner steps: ${state.step}/${state.maxSteps}  |  Elapsed: ${formatElapsed(now() - state.startedAt)}`,
      `Status: ${clip(state.status, contentWidth - 8)}`,
      `Last action: ${formatAction(state.action, contentWidth - 13)}`,
      "",
      "Latest observation",
      ...summarizeObservation(state.observation, contentWidth).map((line) => `  ${line}`)
    ];
    output.write(`\u001B[H\u001B[2J${lines.join("\n")}\n`);
  };

  return {
    get enabled() {
      return enabled;
    },
    start(details) {
      state.objective = details.objective;
      state.baseUrl = details.baseUrl;
      state.provider = details.provider;
      state.maxSteps = details.maxSteps;
      state.startedAt = now();
      render();
    },
    observe(observation, step) {
      state.observation = observation;
      state.step = step;
      state.status = "Observation collected; requesting next action";
      render();
    },
    action(action) {
      state.action = action;
      state.status = "Executing planner action";
      render();
    },
    status(message) {
      state.status = message;
      render();
    },
    finish(status) {
      state.terminalStatus = status.toUpperCase();
      state.status = status === "passed" ? "Test completed" : state.status;
      render();
    }
  };
}