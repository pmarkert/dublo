export async function collectObservation(page, observationConfig, turnToken) {
  return page.evaluate(({ config, turnToken: activeTurnToken }) => {
    const cfg = config && typeof config === "object" ? config : {};

    const controlsSelector =
      typeof cfg.controlsSelector === "string" && cfg.controlsSelector.trim().length > 0
        ? cfg.controlsSelector
        : "button, a, input, textarea, select, [role='button'], [role='link'], [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']";
    const maxControls = Number.isFinite(cfg.maxControls) ? Math.max(1, Number(cfg.maxControls)) : 80;
    const headingSelector =
      typeof cfg.headingSelector === "string" && cfg.headingSelector.trim().length > 0
        ? cfg.headingSelector
        : "h1, h2, h3";
    const maxHeadings = Number.isFinite(cfg.maxHeadings) ? Math.max(0, Number(cfg.maxHeadings)) : 10;
    const alertSelector =
      typeof cfg.alertSelector === "string" && cfg.alertSelector.trim().length > 0
        ? cfg.alertSelector
        : "[role='alert']";
    const maxAlerts = Number.isFinite(cfg.maxAlerts) ? Math.max(0, Number(cfg.maxAlerts)) : 6;
    const documentTextMaxChars = Number.isFinite(cfg.documentTextMaxChars)
      ? Math.max(1, Number(cfg.documentTextMaxChars))
      : 2400;
    const maxOptionsPerControl = Number.isFinite(cfg.maxOptionsPerControl)
      ? Math.max(1, Number(cfg.maxOptionsPerControl))
      : 30;

    const ignoreControlSelectors = Array.isArray(cfg.ignoreControlSelectors)
      ? cfg.ignoreControlSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const ignoreControlTextPatterns = Array.isArray(cfg.ignoreControlTextPatterns)
      ? cfg.ignoreControlTextPatterns.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const priorityControlSelectors = Array.isArray(cfg.priorityControlSelectors)
      ? cfg.priorityControlSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const documentTextScopeSelectors = Array.isArray(cfg.documentTextScopeSelectors)
      ? cfg.documentTextScopeSelectors.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];

    const normalizeText = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const resolveReferencedText = (ids) =>
      ids
        .split(/\s+/)
        .map((id) => globalThis.document.getElementById(id))
        .map((element) => normalizeText(element?.innerText || element?.textContent || ""))
        .filter(Boolean)
        .join(" · ");

    const queryAllWithin = (root, selector) => {
      try {
        return Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    };

    const isVisible = (el) => {
      const style = globalThis.window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const leafTextSegments = (el) => {
      const segments = [];
      const visit = (node) => {
        const children = Array.from(node.children || []).filter((child) => isVisible(child));
        if (children.length === 0) {
          const text = normalizeText(node.innerText || node.textContent || "");
          if (text) segments.push(text);
          return;
        }

        for (const child of children) visit(child);
      };
      visit(el);
      return [...new Set(segments)];
    };

    const resolveControlName = (el, textSegments) => {
      const labelledBy = resolveReferencedText(el.getAttribute("aria-labelledby") || "");
      if (labelledBy) return labelledBy;

      const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
      if (ariaLabel) return ariaLabel;

      if ("labels" in el && el.labels?.length) {
        const labels = Array.from(el.labels)
          .map((label) => normalizeText(label.innerText || label.textContent || ""))
          .filter(Boolean)
          .join(" · ");
        if (labels) return labels;
      }

      const id = el.getAttribute("id") || "";
      const associatedLabel = id
        ? normalizeText(globalThis.document.querySelector(`label[for='${globalThis.CSS.escape(id)}']`)?.innerText || "")
        : "";
      return associatedLabel || textSegments[0] || normalizeText(el.innerText || el.textContent || "");
    };

    const resolveContextPath = (el, scopeRoot) => {
      const parts = [];
      let current = el.parentElement;
      while (current && current !== scopeRoot.parentElement) {
        if (current === scopeRoot && current.getAttribute("role") === "dialog") {
          const title = resolveModalTitle(current);
          if (title) parts.unshift(title);
          break;
        }

        const role = current.getAttribute("role") || "";
        if (current.tagName === "FORM") {
          parts.unshift("form");
        } else if (current.tagName === "FIELDSET") {
          const legend = normalizeText(current.querySelector("legend")?.innerText || "");
          parts.unshift(legend || "fieldset");
        } else if (role === "group" || role === "region") {
          const name = resolveControlName(current, leafTextSegments(current));
          parts.unshift(name || role);
        }
        current = current.parentElement;
      }
      return [...new Set(parts)];
    };

    const resolveModalTitle = (modalEl) => {
      const labelledBy = modalEl.getAttribute("aria-labelledby") || "";
      if (labelledBy) {
        const heading = globalThis.document.getElementById(labelledBy);
        if (heading) {
          const text = normalizeText(heading.textContent || "");
          if (text) {
            return text;
          }
        }
      }

      const ariaLabel = normalizeText(modalEl.getAttribute("aria-label") || "");
      if (ariaLabel) {
        return ariaLabel;
      }

      const heading = queryAllWithin(modalEl, "h1, h2, h3, [role='heading']")
        .map((el) => normalizeText(el.textContent || ""))
        .find(Boolean);
      return heading || "";
    };

    const findActiveModal = () => {
      const selectors = [
        "[role='dialog'][aria-modal='true']",
        "dialog[open]",
        "[role='dialog'][data-state='open']",
        "[role='dialog']",
      ];

      const candidates = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const el of queryAllWithin(globalThis.document, selector)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!isVisible(el)) continue;
          candidates.push(el);
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      let best = candidates[0];
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const el of candidates) {
        const style = globalThis.window.getComputedStyle(el);
        const zIndex = Number.parseFloat(style.zIndex || "0");
        const rect = el.getBoundingClientRect();
        const area = Math.max(0, rect.width * rect.height);
        const score = (Number.isFinite(zIndex) ? zIndex : 0) * 1_000_000 + area;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }

      return best;
    };

    const activeModal = findActiveModal();

    const getVisibleClientRect = (el) => {
      const rect = el.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.left, globalThis.window.innerWidth));
      const right = Math.max(0, Math.min(rect.right, globalThis.window.innerWidth));
      const top = Math.max(0, Math.min(rect.top, globalThis.window.innerHeight));
      const bottom = Math.max(0, Math.min(rect.bottom, globalThis.window.innerHeight));

      if (right - left < 1 || bottom - top < 1) {
        return null;
      }

      return { left, right, top, bottom };
    };

    const isLayerClickable = (el) => {
      if (!isVisible(el)) {
        return false;
      }

      const style = globalThis.window.getComputedStyle(el);
      if (style.pointerEvents === "none") {
        return false;
      }

      const rect = getVisibleClientRect(el);
      if (!rect) {
        return false;
      }

      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      const topEl = globalThis.document.elementFromPoint(cx, cy);
      if (!topEl) {
        return false;
      }

      if (topEl === el || el.contains(topEl)) {
        return true;
      }

      const topLabel = topEl.closest("label");
      if (topLabel && "control" in topLabel && topLabel.control === el) {
        return true;
      }

      return false;
    };

    const allVisibleControls = queryAllWithin(globalThis.document, controlsSelector).filter((el) => isVisible(el));
    const visibleOutsideModalControls = activeModal
      ? allVisibleControls.filter((el) => !activeModal.contains(el))
      : [];
    const bodyStyle = globalThis.document.body
      ? globalThis.window.getComputedStyle(globalThis.document.body)
      : null;
    const modalBlocksBackground = Boolean(activeModal) && (
      activeModal.getAttribute("aria-modal") === "true" ||
      activeModal.matches("dialog[open]") ||
      globalThis.document.body?.hasAttribute("data-scroll-locked") ||
      bodyStyle?.pointerEvents === "none" ||
      (visibleOutsideModalControls.length > 0 &&
        !visibleOutsideModalControls.some((el) => isLayerClickable(el)))
    );
    const scopeRoot = modalBlocksBackground && activeModal ? activeModal : globalThis.document;
    const activeOverlayTriggers = queryAllWithin(
      scopeRoot,
      "[aria-expanded='true'][aria-controls], [aria-expanded='true'][aria-owns]"
    );
    const activeOverlayRoots = activeOverlayTriggers
      .flatMap((trigger) =>
        `${trigger.getAttribute("aria-controls") || ""} ${trigger.getAttribute("aria-owns") || ""}`
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => globalThis.document.getElementById(id))
      )
      .filter((overlay) => overlay && isVisible(overlay));
    const interactionRoots = [...new Set([scopeRoot, ...activeOverlayRoots])];
    const queryAllInteractionRoots = (selector) =>
      [...new Set(interactionRoots.flatMap((root) => queryAllWithin(root, selector)))];
    const overlayControlSelector = "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='treeitem']";
    const overlayControls = [...new Set(activeOverlayRoots.flatMap((root) => queryAllWithin(root, overlayControlSelector)))];
    const isActiveOverlayControl = (el) => overlayControls.includes(el);

    const matchesAnySelector = (el, selectors) =>
      selectors.some((selector) => {
        try {
          return el.matches(selector);
        } catch {
          return false;
        }
      });

    const shouldIgnoreControl = (el) => {
      if (matchesAnySelector(el, ignoreControlSelectors)) {
        return true;
      }

      if (ignoreControlTextPatterns.length === 0) {
        return false;
      }

      const candidate = normalizeText(
        `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`
      ).toLowerCase();

      return ignoreControlTextPatterns.some((pattern) => {
        try {
          return new RegExp(pattern, "i").test(candidate);
        } catch {
          return candidate.includes(pattern.toLowerCase());
        }
      });
    };

    const selectedElements = [];
    const seenElements = new Set();

    for (const el of overlayControls) {
      if (selectedElements.length >= maxControls) break;
      if (!isVisible(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: true });
    }

    for (const selector of priorityControlSelectors) {
      const nodes = queryAllInteractionRoots(selector);

      for (const el of nodes) {
        if (seenElements.has(el)) continue;
        if (!isVisible(el)) continue;
        if (!isActiveOverlayControl(el) && !isLayerClickable(el)) continue;
        if (shouldIgnoreControl(el)) continue;
        seenElements.add(el);
        selectedElements.push({ el, priority: true });
      }
    }

    let generalNodes = [];
    generalNodes = queryAllInteractionRoots(controlsSelector);

    for (const el of generalNodes) {
      if (selectedElements.length >= maxControls) break;
      if (seenElements.has(el)) continue;
      if (!isVisible(el)) continue;
      if (!isActiveOverlayControl(el) && !isLayerClickable(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: false });
    }

    for (const el of queryAllWithin(globalThis.document, "[data-agentic-id], [data-agentic-turn], [data-agentic-scroll-id]")) {
      el.removeAttribute("data-agentic-id");
      el.removeAttribute("data-agentic-turn");
      el.removeAttribute("data-agentic-scroll-id");
    }

    const scrollRoot = scopeRoot === globalThis.document ? globalThis.document.body : scopeRoot;
    const scrollableElements = [scrollRoot, ...queryAllWithin(scopeRoot, "*")].filter((el, index, elements) => {
      if (!el || elements.indexOf(el) !== index || !isVisible(el)) return false;
      const style = globalThis.window.getComputedStyle(el);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 1
      );
    });
    const scrollContainers = scrollableElements.map((el, index) => {
      const id = `s${index + 1}`;
      el.setAttribute("data-agentic-scroll-id", id);
      el.setAttribute("data-agentic-turn", activeTurnToken);
      return {
        id,
        contextPath: resolveContextPath(el, scopeRoot),
        canScrollUp: el.scrollTop > 1,
        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 1
      };
    });

    let sequence = 0;
    const visibleControls = selectedElements.map(({ el, priority }) => {
      sequence += 1;
      const agenticId = `a${sequence}`;
      el.setAttribute("data-agentic-id", agenticId);
      el.setAttribute("data-agentic-turn", activeTurnToken);

      const textSegments = leafTextSegments(el);
      const text = textSegments.join(" · ") || normalizeText(el.innerText || el.textContent || "");
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const label = resolveControlName(el, textSegments);
      const description = resolveReferencedText(el.getAttribute("aria-describedby") || "");
      const disabled =
        ("disabled" in el && Boolean(el.disabled)) || el.getAttribute("aria-disabled") === "true" || false;

      let value = "";
      let hasValue = false;
      let checked = el.getAttribute("aria-checked") === "true";

      if (tag === "input") {
        const input = /** @type {HTMLInputElement} */ (el);
        checked = Boolean(input.checked);

        if (type === "checkbox" || type === "radio") {
          hasValue = true;
          value = checked ? "checked" : "unchecked";
        } else {
          value = input.value || "";
          hasValue = value.length > 0;
        }
      } else if (tag === "textarea") {
        const textarea = /** @type {HTMLTextAreaElement} */ (el);
        value = textarea.value || "";
        hasValue = value.length > 0;
      } else if (tag === "select") {
        const select = /** @type {HTMLSelectElement} */ (el);
        value = select.value || "";
        hasValue = value.length > 0;
      } else if (el.getAttribute("contenteditable") === "true") {
        value = text;
        hasValue = value.length > 0;
      }

      const options = tag === "select"
        ? Array.from(/** @type {HTMLSelectElement} */ (el).options)
            .map((option) => ({
              label: normalizeText(option.label || option.textContent || ""),
              value: option.value,
              ...(option.selected ? { selected: true } : {}),
              ...(option.disabled ? { disabled: true } : {})
            }))
            .filter((option) => option.label || option.value)
            .slice(0, maxOptionsPerControl)
        : [];

      return {
        id: agenticId,
        tag,
        role,
        type,
        priority,
        text,
        ariaLabel,
        label,
        ...(description ? { description } : {}),
        contextPath: resolveContextPath(el, scopeRoot),
        placeholder,
        ...(value ? { value } : {}),
        ...(options.length > 0 ? { options } : {}),
        hasValue,
        checked,
        ...(el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? { required: true } : {}),
        ...(el.getAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
        ...(el.getAttribute("aria-selected") ? { selected: el.getAttribute("aria-selected") === "true" } : {}),
        ...(el.getAttribute("aria-pressed") ? { pressed: el.getAttribute("aria-pressed") === "true" } : {}),
        ...(el.getAttribute("aria-current") ? { current: el.getAttribute("aria-current") } : {}),
        ...(el.getAttribute("aria-invalid") === "true" ? { invalid: true } : {}),
        ...(disabled ? { disabled: true } : {}),
      };
    });

    const headings = queryAllWithin(scopeRoot, headingSelector)
      .map((el) => normalizeText(el.textContent || ""))
      .filter(Boolean)
      .slice(0, maxHeadings);

    const alerts = queryAllWithin(scopeRoot, alertSelector)
      .map((el) => normalizeText(el.textContent || ""))
      .filter(Boolean)
      .slice(0, maxAlerts);

    let textRoot = null;
    if (modalBlocksBackground && activeModal) {
      textRoot = activeModal;
    } else if (documentTextScopeSelectors.length > 0) {
      for (const selector of documentTextScopeSelectors) {
        const nodes = queryAllWithin(globalThis.document, selector);

        const firstVisibleNode = nodes.find((node) => isVisible(node));
        if (firstVisibleNode) {
          textRoot = firstVisibleNode;
          break;
        }
      }
    }

    if (!textRoot && globalThis.document.body) {
      textRoot = globalThis.document.body;
    }
    let documentText = "";
    if (textRoot) {
      documentText = normalizeText(typeof textRoot.innerText === "string" ? textRoot.innerText : "");
    }

    documentText = documentText.slice(0, documentTextMaxChars);

    return {
      url: globalThis.window.location.href,
      title: globalThis.document.title,
      modal: {
        open: Boolean(activeModal),
        blocksBackground: modalBlocksBackground,
        role: activeModal?.getAttribute("role") || "",
        ariaModal: activeModal?.getAttribute("aria-modal") || "",
        title: activeModal ? resolveModalTitle(activeModal) : "",
      },
      headings,
      alerts,
      documentText,
      scrollContainers,
      controls: visibleControls,
    };
  }, { config: observationConfig, turnToken });
}
