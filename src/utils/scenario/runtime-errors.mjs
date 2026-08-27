const DEFAULT_MAX_ENTRIES = 20;
const MAX_TEXT_CHARS = 300;

function clipText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_TEXT_CHARS ? normalized : `${normalized.slice(0, MAX_TEXT_CHARS - 1)}...`;
}

/**
 * Collects deterministic runtime signals from the page since the last drain:
 * console errors, uncaught exceptions, failed/error HTTP responses, failed
 * requests, and native dialogs. These are the raw material the QA, chaos, and
 * security oracles need, and they cost no model tokens.
 *
 * Native dialogs (alert/confirm/prompt) are dismissed so an unexpected dialog
 * cannot hang the run, and each is recorded so the planner can react to it.
 */
export function createRuntimeErrorTracker(page, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Number(options.maxEntries)) : DEFAULT_MAX_ENTRIES;
  const minStatus = Number.isFinite(options.minStatus) ? Number(options.minStatus) : 400;
  /**
   * @typedef {{ type: string, text?: string, status?: number, method?: string, url?: string, dialogType?: string }} RuntimeSignal
   * @type {RuntimeSignal[]}
   */
  let buffer = [];
  let droppedCount = 0;

  const push = (entry) => {
    if (buffer.length >= maxEntries) {
      droppedCount += 1;
      buffer.shift();
    }
    buffer.push(entry);
  };

  const onConsole = (message) => {
    try {
      if (message.type() !== "error") return;
      const text = clipText(message.text());
      if (text) push({ type: "console", text });
    } catch {
      // A console message can outlive its execution context; ignore.
    }
  };

  const onPageError = (error) => {
    const text = clipText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    if (text) push({ type: "pageerror", text });
  };

  const onResponse = (response) => {
    try {
      const status = response.status();
      if (status < minStatus) return;
      const request = response.request();
      // Ignore preflight/beacon noise that is not user-visible.
      if (request.method() === "OPTIONS") return;
      push({ type: "response", status, method: request.method(), url: clipText(response.url()) });
    } catch {
      // Response objects can become unusable after navigation; ignore.
    }
  };

  const onRequestFailed = (request) => {
    try {
      const failure = request.failure();
      // net::ERR_ABORTED is routine on SPA navigations and cancellations.
      const errorText = failure?.errorText || "";
      if (!errorText || errorText.includes("ERR_ABORTED")) return;
      push({ type: "requestfailed", method: request.method(), url: clipText(request.url()), text: clipText(errorText) });
    } catch {
      // ignore
    }
  };

  const onDialog = (dialog) => {
    push({ type: "dialog", dialogType: dialog.type(), text: clipText(dialog.message()) });
    dialog.dismiss().catch(() => {
      // The dialog may already be handled; ignore.
    });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("dialog", onDialog);

  return {
    /** Returns runtime signals accumulated since the last drain and clears the buffer. */
    drain() {
      const entries = buffer;
      const dropped = droppedCount;
      buffer = [];
      droppedCount = 0;
      if (dropped > 0) {
        return [{ type: "note", text: `${dropped} earlier runtime signal(s) dropped (buffer limit ${maxEntries}).` }, ...entries];
      }
      return entries;
    },
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("dialog", onDialog);
      buffer = [];
    },
  };
}
