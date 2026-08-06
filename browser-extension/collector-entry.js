import { DEFAULT_OBSERVATION_CONFIG } from "../src/utils/scenario/observation-defaults.mjs";
import { collectObservationInPage } from "../src/utils/scenario/observation.mjs";

(() => {
  if (globalThis.__dubloObservationWatcher) {
    globalThis.__dubloObservationWatcher.capture();
    return;
  }

  let updateTimer;
  let observationTurn = 0;
  let active = true;
  const observer = new MutationObserver(scheduleCapture);
  const observe = () =>
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
  const dispose = () => {
    active = false;
    observer.disconnect();
    globalThis.clearTimeout(updateTimer);
    document.removeEventListener("input", scheduleCapture, true);
    document.removeEventListener("change", scheduleCapture, true);
    globalThis.removeEventListener("hashchange", scheduleCapture);
    globalThis.removeEventListener("popstate", scheduleCapture);
    delete globalThis.__dubloObservationWatcher;
  };

  const capture = () => {
    if (!active) return;
    observer.disconnect();
    try {
      const payload = collectObservationInPage({
        config: DEFAULT_OBSERVATION_CONFIG,
        turnToken: `extension-${++observationTurn}`
      });
      try {
        chrome.runtime.sendMessage({ type: "dublo-observation", payload });
      } catch {
        dispose();
      }
    } finally {
      if (active) observe();
    }
  };

  function scheduleCapture() {
    if (!active) return;
    globalThis.clearTimeout(updateTimer);
    updateTimer = globalThis.setTimeout(capture, 200);
  }

  document.addEventListener("input", scheduleCapture, true);
  document.addEventListener("change", scheduleCapture, true);
  globalThis.addEventListener("hashchange", scheduleCapture);
  globalThis.addEventListener("popstate", scheduleCapture);
  globalThis.__dubloObservationWatcher = { capture, dispose };
  observe();
  capture();
})();