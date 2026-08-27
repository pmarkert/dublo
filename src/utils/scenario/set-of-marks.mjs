const OVERLAY_ID = "dublo-set-of-marks";

/**
 * Draws numbered marks over the controls observed this turn (matched by their
 * data-agentic-id) so a vision model grounds its answer to the exact elements
 * the executor can act on. This is "set-of-marks" prompting: the model sees the
 * same ids in the image that it sees in the structured observation.
 *
 * Returns the number of marks drawn. Call clearSetOfMarks afterwards.
 *
 * @returns {Promise<number>}
 */
export async function drawSetOfMarks(page, turnToken) {
  return page.evaluate((activeTurnToken) => {
    const doc = globalThis.document;
    const existing = doc.getElementById("dublo-set-of-marks");
    if (existing) existing.remove();

    // Collect marked controls, piercing open shadow roots the same way the
    // observation walker does.
    const marked = [];
    const seen = new Set();
    const visit = (root) => {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(`[data-agentic-turn="${activeTurnToken}"][data-agentic-id]`));
      } catch {
        matches = [];
      }
      for (const el of matches) {
        if (!seen.has(el)) {
          seen.add(el);
          marked.push(el);
        }
      }
      let descendants = [];
      try {
        descendants = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
      } catch {
        descendants = [];
      }
      for (const el of descendants) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(doc);

    const overlay = doc.createElement("div");
    overlay.id = "dublo-set-of-marks";
    overlay.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;"
    );

    let count = 0;
    for (const el of marked) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > globalThis.window.innerHeight || rect.left > globalThis.window.innerWidth) {
        continue;
      }
      const id = el.getAttribute("data-agentic-id") || "";

      const box = doc.createElement("div");
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      box.setAttribute(
        "style",
        `position:fixed;left:${left}px;top:${top}px;width:${Math.max(1, rect.width)}px;height:${Math.max(1, rect.height)}px;box-sizing:border-box;border:2px solid #e5006d;pointer-events:none;`
      );

      const label = doc.createElement("span");
      label.textContent = id;
      label.setAttribute(
        "style",
        `position:fixed;left:${left}px;top:${Math.max(0, top - 14)}px;background:#e5006d;color:#fff;font:700 11px/1.2 ui-monospace,monospace;padding:1px 4px;pointer-events:none;white-space:nowrap;`
      );

      overlay.appendChild(box);
      overlay.appendChild(label);
      count += 1;
    }

    if (doc.body) doc.body.appendChild(overlay);
    return count;
  }, turnToken);
}

export async function clearSetOfMarks(page) {
  try {
    await page.evaluate(() => {
      const overlay = globalThis.document.getElementById("dublo-set-of-marks");
      if (overlay) overlay.remove();
    });
  } catch {
    // The page may have navigated or closed; nothing to clean up.
  }
}

export const SET_OF_MARKS_OVERLAY_ID = OVERLAY_ID;
