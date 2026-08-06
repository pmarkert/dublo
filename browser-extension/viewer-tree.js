const tabId = new URLSearchParams(location.search).get("tabId");
const key = tabId ? `observation:${tabId}` : "";
const status = document.querySelector("#status");
const target = document.querySelector("#observation");
let selectedView = "ui";

const escapeHtml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function treeLabel(node) {
  if (node.kind === "context") return node.name;
  if (node.kind === "dialog") return `${node.role || "dialog"}: ${node.title || "Untitled"}${node.blocking ? " (blocking)" : ""}`;
  if (node.kind === "scroll") return `Scroll ${node.id}${node.label ? `: ${node.label}` : ""} (${node.canScrollUp ? "up " : ""}${node.canScrollDown ? "down" : ""})`;
  if (node.kind === "preview") return `Scroll ${node.direction} to reveal`;
  if (node.kind === "control" || node.kind === "preview-control") {
    const identity = node.label || node.text || node.ariaLabel || "Unnamed control";
    const type = [node.tag, node.role, node.type].filter(Boolean).join(" / ") || "control";
    return `${node.kind === "preview-control" ? "Preview: " : ""}${node.id ? `${node.id} - ` : ""}${identity} (${type})`;
  }
  if (node.kind === "heading" || node.kind === "preview-heading") return `${node.kind === "preview-heading" ? "Preview: " : ""}Heading level ${node.level}: ${node.text}`;
  if (node.kind === "text" || node.kind === "preview-text") return `${node.kind === "preview-text" ? "Preview: " : ""}${node.text}`;
  if (node.kind === "alert") return `Alert: ${node.text}`;
  return node.kind;
}

function renderTree(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return '<p class="empty-note">No observable page content captured.</p>';
  }
  return `<ul class="observation-tree">${nodes.map((node) => `<li class="tree-node tree-node-${escapeHtml(node.kind)}"><span>${escapeHtml(treeLabel(node))}</span>${node.children?.length ? renderTree(node.children) : ""}</li>`).join("")}</ul>`;
}

function render(observation) {
  const activeDialog = observation.activeDialog;
  const isRawView = selectedView === "raw";
  const rawJson = JSON.stringify(observation, null, 2);
  target.innerHTML = `<h4>Observation</h4>
    <div class="observation-toolbar">
      <div class="observation-mode-toggle" role="group" aria-label="Observation view">
        <button type="button" aria-pressed="${!isRawView}" data-view="ui">UI</button>
        <button type="button" aria-pressed="${isRawView}" data-view="raw">Raw</button>
      </div>
      <button class="copy-json" type="button" data-copy-json>Copy JSON</button>
    </div>
    <div data-panel="ui" class="observation-layout"${isRawView ? " hidden" : ""}>
      <div class="observation-grid">
        <article class="info-card"><span class="field-label">URL</span><strong>${escapeHtml(observation.url || "n/a")}</strong></article>
        <article class="info-card"><span class="field-label">Title</span><strong>${escapeHtml(observation.title || "Untitled")}</strong></article>
        <article class="info-card"><span class="field-label">Active dialog</span><strong>${activeDialog ? escapeHtml(activeDialog.title || activeDialog.role) : "None"}</strong>${activeDialog ? `<div class="mini-pill-row"><span class="mini-pill">${activeDialog.blocking ? "blocks background" : "background accessible"}</span><span class="mini-pill">${escapeHtml(activeDialog.role)}</span></div>` : ""}</article>
      </div>
      <section class="observation-section"><span class="field-label">Observed hierarchy</span>${renderTree(observation.tree)}</section>
    </div>
    <pre data-panel="raw" class="raw-observation"${isRawView ? "" : " hidden"}>${escapeHtml(rawJson)}</pre>`;
  target.hidden = false;
  target.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    selectedView = button.dataset.view === "raw" ? "raw" : "ui";
    const raw = selectedView === "raw";
    target.querySelectorAll("[data-view]").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
    target.querySelector('[data-panel="ui"]').hidden = raw;
    target.querySelector('[data-panel="raw"]').hidden = !raw;
  }));
  target.querySelector("[data-copy-json]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(rawJson);
      status.textContent = "Raw observation JSON copied to the clipboard.";
    } catch {
      status.textContent = "Could not copy JSON. Check this extension page's clipboard permission.";
    }
  });
}

async function load() {
  if (!key) { status.textContent = "Missing source tab."; return; }
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  if (value?.error) { status.textContent = value.error; return; }
  if (value) { status.textContent = "Captured from the active page."; render(value); return; }
  window.setTimeout(load, 150);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !changes[key]?.newValue) return;
  const observation = changes[key].newValue;
  if (observation.error) {
    status.textContent = observation.error;
    return;
  }
  status.textContent = "Live updates enabled. Last snapshot refreshed now.";
  render(observation);
});

void load();
