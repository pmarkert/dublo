"use strict";
(() => {
  // src/utils/scenario/observation-defaults.mjs
  var DEFAULT_OBSERVATION_CONFIG = {
    controlsSelector: "button, a, input, textarea, select, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']",
    maxControls: 80,
    ignoreControlSelectors: ["button[aria-label='Open Tanstack query devtools']"],
    ignoreControlTextPatterns: [],
    priorityControlSelectors: ["nav a", "nav button", "[role='navigation'] a", "[role='navigation'] button"],
    headingSelector: "h1, h2, h3",
    maxHeadings: 10,
    alertSelector: "[role='alert']",
    maxAlerts: 6,
    maxTextNodes: 40,
    textNodeMaxChars: 280
  };

  // src/utils/scenario/observation.mjs
  var collectObservationInPage = ({ config, turnToken: activeTurnToken }) => {
    const cfg = config && typeof config === "object" ? config : {};
    const controlsSelector = typeof cfg.controlsSelector === "string" && cfg.controlsSelector.trim().length > 0 ? cfg.controlsSelector : "button, a, input, textarea, select, [role='button'], [role='link'], [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']";
    const maxControls = Number.isFinite(cfg.maxControls) ? Math.max(1, Number(cfg.maxControls)) : 80;
    const headingSelector = typeof cfg.headingSelector === "string" && cfg.headingSelector.trim().length > 0 ? cfg.headingSelector : "h1, h2, h3";
    const maxHeadings = Number.isFinite(cfg.maxHeadings) ? Math.max(0, Number(cfg.maxHeadings)) : 10;
    const alertSelector = typeof cfg.alertSelector === "string" && cfg.alertSelector.trim().length > 0 ? cfg.alertSelector : "[role='alert']";
    const maxAlerts = Number.isFinite(cfg.maxAlerts) ? Math.max(0, Number(cfg.maxAlerts)) : 6;
    const maxTextNodes = Number.isFinite(cfg.maxTextNodes) ? Math.max(0, Number(cfg.maxTextNodes)) : 40;
    const textNodeMaxChars = Number.isFinite(cfg.textNodeMaxChars) ? Math.max(1, Number(cfg.textNodeMaxChars)) : 280;
    const maxOptionsPerControl = Number.isFinite(cfg.maxOptionsPerControl) ? Math.max(1, Number(cfg.maxOptionsPerControl)) : 30;
    const maxScrollPreviews = Number.isFinite(cfg.maxScrollPreviews) ? Math.max(0, Number(cfg.maxScrollPreviews)) : 20;
    const ignoreControlSelectors = Array.isArray(cfg.ignoreControlSelectors) ? cfg.ignoreControlSelectors.filter(
      (item) => typeof item === "string" && item.trim().length > 0
    ) : [];
    const ignoreControlTextPatterns = Array.isArray(cfg.ignoreControlTextPatterns) ? cfg.ignoreControlTextPatterns.filter(
      (item) => typeof item === "string" && item.trim().length > 0
    ) : [];
    const priorityControlSelectors = Array.isArray(cfg.priorityControlSelectors) ? cfg.priorityControlSelectors.filter(
      (item) => typeof item === "string" && item.trim().length > 0
    ) : [];
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const hashControlIdentity = (value) => {
      let hash = 2166136261;
      for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    const resolveReferencedText = (ids) => ids.split(/\s+/).map((id) => globalThis.document.getElementById(id)).map((element) => normalizeText(element?.innerText || element?.textContent || "")).filter(Boolean).join(" \xB7 ");
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
        const labels = Array.from(el.labels).map((label) => normalizeText(label.innerText || label.textContent || "")).filter(Boolean).join(" \xB7 ");
        if (labels) return labels;
      }
      const id = el.getAttribute("id") || "";
      const associatedLabel = id ? normalizeText(
        globalThis.document.querySelector(`label[for='${globalThis.CSS.escape(id)}']`)?.innerText || ""
      ) : "";
      return associatedLabel || textSegments[0] || normalizeText(el.innerText || el.textContent || "");
    };
    const resolveLandmarkLabel = (el) => {
      const labelledBy = resolveReferencedText(el.getAttribute("aria-labelledby") || "");
      if (labelledBy) return labelledBy;
      const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
      if (ariaLabel) return ariaLabel;
      const nativeLandmarks = {
        ASIDE: "complementary",
        FOOTER: "contentinfo",
        HEADER: "banner",
        MAIN: "main",
        NAV: "navigation"
      };
      return el.getAttribute("role") || nativeLandmarks[el.tagName] || "";
    };
    const resolveContextPath = (el, scopeRoot2, activeDialog2) => {
      const parts = [];
      let current = el.parentElement;
      while (current && current !== scopeRoot2.parentElement) {
        if (current === activeDialog2 && ["dialog", "alertdialog"].includes(current.getAttribute("role") || "")) {
          const title = resolveDialogTitle(current);
          if (title) parts.unshift(title);
          break;
        }
        const role = current.getAttribute("role") || "";
        if (current.tagName === "FORM") {
          parts.unshift("form");
        } else if (current.tagName === "FIELDSET") {
          const legend = normalizeText(current.querySelector("legend")?.innerText || "");
          parts.unshift(legend || "fieldset");
        } else if (["NAV", "HEADER", "MAIN", "FOOTER", "SECTION"].includes(current.tagName)) {
          const name = resolveLandmarkLabel(current);
          if (name) parts.unshift(name);
        } else if (role === "group" || role === "region") {
          const name = resolveControlName(current, leafTextSegments(current));
          parts.unshift(name || role);
        }
        current = current.parentElement;
      }
      return [...new Set(parts)];
    };
    const resolveDialogTitle = (dialogEl) => {
      const labelledBy = dialogEl.getAttribute("aria-labelledby") || "";
      if (labelledBy) {
        const heading2 = globalThis.document.getElementById(labelledBy);
        if (heading2) {
          const text = normalizeText(heading2.textContent || "");
          if (text) {
            return text;
          }
        }
      }
      const ariaLabel = normalizeText(dialogEl.getAttribute("aria-label") || "");
      if (ariaLabel) {
        return ariaLabel;
      }
      const heading = queryAllWithin(dialogEl, "h1, h2, h3, [role='heading']").map((el) => normalizeText(el.textContent || "")).find(Boolean);
      return heading || "";
    };
    const resolveScrollContainerLabel = (el, scopeRoot2, activeDialog2) => {
      const landmarkLabel = resolveLandmarkLabel(el);
      if (landmarkLabel) return landmarkLabel;
      const contentType = el.querySelector("form") ? "form" : "content";
      const dialog = el.closest("[role='dialog'], [role='alertdialog'], dialog");
      const dialogTitle = dialog && scopeRoot2.contains(dialog) && dialog === activeDialog2 ? resolveDialogTitle(dialog) : "";
      return dialogTitle ? `${dialogTitle} ${contentType}` : `scrollable ${contentType}`;
    };
    const findActiveDialog = () => {
      const selectors = [
        "[role='alertdialog'][aria-modal='true']",
        "[role='alertdialog'][data-state='open']",
        "[role='alertdialog']",
        "[role='dialog'][aria-modal='true']",
        "dialog[open]",
        "[role='dialog'][data-state='open']",
        "[role='dialog']"
      ];
      const candidates = [];
      const seen = /* @__PURE__ */ new Set();
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
        const alertDialogPriority = el.getAttribute("role") === "alertdialog" ? 1e12 : 0;
        const score = alertDialogPriority + (Number.isFinite(zIndex) ? zIndex : 0) * 1e6 + area;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      return best;
    };
    const activeDialog = findActiveDialog();
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
    const isDisabled = (el) => "disabled" in el && Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
    const allVisibleControls = queryAllWithin(globalThis.document, controlsSelector).filter(
      (el) => isVisible(el)
    );
    const visibleOutsideDialogControls = activeDialog ? allVisibleControls.filter((el) => !activeDialog.contains(el)) : [];
    const bodyStyle = globalThis.document.body ? globalThis.window.getComputedStyle(globalThis.document.body) : null;
    const dialogBlocksBackground = Boolean(activeDialog) && (activeDialog.getAttribute("aria-modal") === "true" || activeDialog.matches("dialog[open]") || globalThis.document.body?.hasAttribute("data-scroll-locked") || bodyStyle?.pointerEvents === "none" || visibleOutsideDialogControls.length > 0 && !visibleOutsideDialogControls.some((el) => isLayerClickable(el)));
    const scopeRoot = dialogBlocksBackground && activeDialog ? activeDialog : globalThis.document;
    const activeOverlayTriggers = queryAllWithin(
      scopeRoot,
      "[aria-expanded='true'][aria-controls], [aria-expanded='true'][aria-owns]"
    );
    const activeOverlayRoots = activeOverlayTriggers.flatMap(
      (trigger) => `${trigger.getAttribute("aria-controls") || ""} ${trigger.getAttribute("aria-owns") || ""}`.split(/\s+/).filter(Boolean).map((id) => globalThis.document.getElementById(id))
    ).filter((overlay) => overlay && isVisible(overlay));
    const interactionRoots = [.../* @__PURE__ */ new Set([scopeRoot, ...activeOverlayRoots])];
    const queryAllInteractionRoots = (selector) => [
      ...new Set(interactionRoots.flatMap((root) => queryAllWithin(root, selector)))
    ];
    const overlayControlSelector = "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='treeitem']";
    const overlayControls = [
      ...new Set(
        activeOverlayRoots.flatMap((root) => queryAllWithin(root, overlayControlSelector))
      )
    ];
    const isActiveOverlayControl = (el) => overlayControls.includes(el);
    const matchesAnySelector = (el, selectors) => selectors.some((selector) => {
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
    const seenElements = /* @__PURE__ */ new Set();
    for (const el of overlayControls) {
      if (selectedElements.length >= maxControls) break;
      if (!isVisible(el)) continue;
      if (!isLayerClickable(el) && !isDisabled(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: true });
    }
    for (const selector of priorityControlSelectors) {
      const nodes = queryAllInteractionRoots(selector);
      for (const el of nodes) {
        if (seenElements.has(el)) continue;
        if (!isVisible(el)) continue;
        if (!isLayerClickable(el) && !isDisabled(el)) continue;
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
      if (!isLayerClickable(el) && !isDisabled(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      selectedElements.push({ el, priority: false });
    }
    for (const el of queryAllWithin(
      globalThis.document,
      "[data-agentic-id], [data-agentic-turn], [data-agentic-scroll-id]"
    )) {
      el.removeAttribute("data-agentic-id");
      el.removeAttribute("data-agentic-turn");
      el.removeAttribute("data-agentic-scroll-id");
    }
    const scrollRoot = scopeRoot === globalThis.document ? globalThis.document.body : scopeRoot;
    const scrollableElements = [scrollRoot, ...queryAllWithin(scopeRoot, "*")].filter(
      (el, index, elements) => {
        if (!el || elements.indexOf(el) !== index || !isVisible(el)) return false;
        const style = globalThis.window.getComputedStyle(el);
        return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
      }
    );
    const scrollContainerIds = /* @__PURE__ */ new Map();
    const scrollContainers = scrollableElements.map((el, index) => {
      const id = `s${index + 1}`;
      scrollContainerIds.set(el, id);
      el.setAttribute("data-agentic-scroll-id", id);
      el.setAttribute("data-agentic-turn", activeTurnToken);
      return {
        id,
        label: resolveScrollContainerLabel(el, scopeRoot, activeDialog),
        contextPath: resolveContextPath(el, scopeRoot, activeDialog),
        canScrollUp: el.scrollTop > 1,
        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 1
      };
    });
    const revealDirection = (el, scrollContainer) => {
      const containerRect = getVisibleClientRect(scrollContainer);
      if (!containerRect) return "";
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= containerRect.top + 1 && scrollContainer.scrollTop > 1) return "up";
      if (rect.top >= containerRect.bottom - 1 && scrollContainer.scrollTop + scrollContainer.clientHeight < scrollContainer.scrollHeight - 1) {
        return "down";
      }
      return "";
    };
    const reservedControlIds = new Set(
      selectedElements.map(({ el }) => el.getAttribute("data-agentic-key")).filter(Boolean)
    );
    const assignedControlIds = /* @__PURE__ */ new Set();
    const documentOrder = new Map(
      queryAllWithin(globalThis.document, "*").map((el, index) => [el, index])
    );
    const visibleControls = selectedElements.map(({ el, priority }) => {
      const textSegments = leafTextSegments(el);
      const text = textSegments.join(" \xB7 ") || normalizeText(el.innerText || el.textContent || "");
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const label = resolveControlName(el, textSegments);
      const contextPath = resolveContextPath(el, scopeRoot, activeDialog);
      const scrollContainer = el.closest("[data-agentic-scroll-id]");
      const scrollContainerId = scrollContainer ? scrollContainerIds.get(scrollContainer) : void 0;
      const description = resolveReferencedText(el.getAttribute("aria-describedby") || "");
      const disabled = isDisabled(el);
      let agenticId = el.getAttribute("data-agentic-key") || "";
      if (!agenticId || assignedControlIds.has(agenticId)) {
        const identity = [
          tag,
          role,
          type,
          el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || el.getAttribute("data-cy") || "",
          el.getAttribute("id") || "",
          el.getAttribute("name") || "",
          el.getAttribute("href") || "",
          el.getAttribute("aria-controls") || "",
          contextPath.join(" > "),
          label || ariaLabel || text,
          placeholder
        ].map((part) => normalizeText(part).toLocaleLowerCase()).join("|");
        const baseId = `ctl_${hashControlIdentity(identity)}`;
        agenticId = baseId;
        let suffix = 2;
        while (reservedControlIds.has(agenticId) || assignedControlIds.has(agenticId)) {
          agenticId = `${baseId}_${suffix}`;
          suffix += 1;
        }
        el.setAttribute("data-agentic-key", agenticId);
        reservedControlIds.add(agenticId);
      }
      assignedControlIds.add(agenticId);
      el.setAttribute("data-agentic-id", agenticId);
      el.setAttribute("data-agentic-turn", activeTurnToken);
      let value = "";
      let hasValue = false;
      let checked = el.getAttribute("aria-checked") === "true";
      if (tag === "input") {
        const input = (
          /** @type {HTMLInputElement} */
          el
        );
        checked = Boolean(input.checked);
        if (type === "checkbox" || type === "radio") {
          hasValue = true;
          value = checked ? "checked" : "unchecked";
        } else {
          value = input.value || "";
          hasValue = value.length > 0;
        }
      } else if (tag === "textarea") {
        const textarea = (
          /** @type {HTMLTextAreaElement} */
          el
        );
        value = textarea.value || "";
        hasValue = value.length > 0;
      } else if (tag === "select") {
        const select = (
          /** @type {HTMLSelectElement} */
          el
        );
        value = select.value || "";
        hasValue = value.length > 0;
      } else if (el.getAttribute("contenteditable") === "true") {
        value = text;
        hasValue = value.length > 0;
      }
      const options = tag === "select" ? Array.from(
        /** @type {HTMLSelectElement} */
        el.options
      ).map((option) => ({
        label: normalizeText(option.label || option.textContent || ""),
        value: option.value,
        ...option.selected ? { selected: true } : {},
        ...option.disabled ? { disabled: true } : {}
      })).filter((option) => option.label || option.value).slice(0, maxOptionsPerControl) : [];
      const isCheckable = tag === "input" && (type === "checkbox" || type === "radio") || el.hasAttribute("aria-checked");
      return {
        id: agenticId,
        order: documentOrder.get(el) || 0,
        tag,
        ...role ? { role } : {},
        ...type ? { type } : {},
        ...priority ? { priority: true } : {},
        ...text ? { text } : {},
        ...ariaLabel ? { ariaLabel } : {},
        ...label ? { label } : {},
        ...description ? { description } : {},
        ...contextPath.length ? { contextPath } : {},
        ...scrollContainerId ? { scrollContainerId } : {},
        ...placeholder ? { placeholder } : {},
        ...value ? { value } : {},
        ...options.length > 0 ? { options } : {},
        ...hasValue ? { hasValue: true } : {},
        ...isCheckable ? { checked } : {},
        ...el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? { required: true } : {},
        ...el.getAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {},
        ...el.getAttribute("aria-selected") ? { selected: el.getAttribute("aria-selected") === "true" } : {},
        ...el.getAttribute("aria-pressed") ? { pressed: el.getAttribute("aria-pressed") === "true" } : {},
        ...el.getAttribute("aria-current") ? { current: el.getAttribute("aria-current") } : {},
        ...el.getAttribute("aria-invalid") === "true" ? { invalid: true } : {},
        ...disabled ? { disabled: true } : {}
      };
    });
    const scrollPreviews = [];
    const addScrollPreview = (preview) => {
      if (scrollPreviews.length < maxScrollPreviews) scrollPreviews.push(preview);
    };
    for (const el of queryAllInteractionRoots(controlsSelector)) {
      if (seenElements.has(el) || !isVisible(el) || shouldIgnoreControl(el)) continue;
      const scrollContainer = el.closest("[data-agentic-scroll-id]");
      const scrollContainerId = scrollContainer ? scrollContainerIds.get(scrollContainer) : void 0;
      const direction = scrollContainer ? revealDirection(el, scrollContainer) : "";
      if (!scrollContainerId || !direction) continue;
      const textSegments = leafTextSegments(el);
      const text = textSegments.join(" \xB7 ") || normalizeText(el.innerText || el.textContent || "");
      const label = resolveControlName(el, textSegments);
      addScrollPreview({
        kind: "control",
        order: documentOrder.get(el) || 0,
        revealDirection: direction,
        scrollContainerId,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        text,
        label,
        ...el.getAttribute("aria-describedby") ? { description: resolveReferencedText(el.getAttribute("aria-describedby")) } : {}
      });
    }
    const headings = queryAllWithin(scopeRoot, headingSelector).map((el) => normalizeText(el.textContent || "")).filter(Boolean).slice(0, maxHeadings);
    const headingNodes = [];
    for (const el of queryAllWithin(scopeRoot, headingSelector)) {
      if (!isVisible(el) || el.closest(controlsSelector)) continue;
      const scrollContainer = el.closest("[data-agentic-scroll-id]");
      const scrollContainerId = scrollContainer ? scrollContainerIds.get(scrollContainer) : void 0;
      const direction = scrollContainer ? revealDirection(el, scrollContainer) : "";
      const heading = {
        text: normalizeText(el.textContent || ""),
        level: Number.parseInt(el.tagName.slice(1), 10) || 0,
        order: documentOrder.get(el) || 0,
        contextPath: resolveContextPath(el, scopeRoot, activeDialog),
        ...scrollContainerId ? { scrollContainerId } : {}
      };
      if (!heading.text) continue;
      if (scrollContainerId && direction) {
        addScrollPreview({ kind: "heading", revealDirection: direction, ...heading });
      } else if (headingNodes.length < maxHeadings) {
        headingNodes.push(heading);
      }
    }
    const alerts = queryAllWithin(scopeRoot, alertSelector).map((el) => normalizeText(el.textContent || "")).filter(Boolean).slice(0, maxAlerts);
    const textNodeSelector = "p, li, dt, dd, blockquote, figcaption, caption, td, th, [role='status'], [role='note'], [role='article']";
    const textWithoutSemanticDescendants = (el) => {
      const segments = [];
      const visit = (node) => {
        if (node.nodeType === globalThis.Node.TEXT_NODE) {
          const text = normalizeText(node.textContent || "");
          if (text) segments.push(text);
          return;
        }
        if (node.nodeType !== globalThis.Node.ELEMENT_NODE) return;
        if (node !== el && (node.matches(controlsSelector) || node.matches(headingSelector))) {
          return;
        }
        for (const child of node.childNodes) visit(child);
      };
      visit(el);
      return normalizeText(segments.join(" "));
    };
    const semanticTextNodes = queryAllWithin(scopeRoot, textNodeSelector);
    const leafTextNodes = queryAllWithin(scopeRoot, "*").filter(
      (el) => Array.from(el.childNodes).some(
        (node) => node.nodeType === globalThis.Node.TEXT_NODE && normalizeText(node.textContent || "")
      )
    );
    const textElements = [...semanticTextNodes, ...leafTextNodes.filter((el) => !el.closest(textNodeSelector))].filter((el, index, elements) => elements.indexOf(el) === index).filter((el) => {
      if (!isVisible(el) || el.closest(controlsSelector) || el.closest(headingSelector)) {
        return false;
      }
      if (el.closest(alertSelector) || el.matches("label") || el.closest("label")) {
        return false;
      }
      return !el.closest("script, style, noscript, template, [aria-hidden='true']");
    });
    const textNodes = [];
    for (const el of textElements) {
      const text = textWithoutSemanticDescendants(el).slice(0, textNodeMaxChars);
      if (!text) continue;
      const scrollContainer = el.closest("[data-agentic-scroll-id]");
      const scrollContainerId = scrollContainer ? scrollContainerIds.get(scrollContainer) : void 0;
      const direction = scrollContainer ? revealDirection(el, scrollContainer) : "";
      const textNode = {
        text,
        order: documentOrder.get(el) || 0,
        contextPath: resolveContextPath(el, scopeRoot, activeDialog),
        ...scrollContainerId ? { scrollContainerId } : {}
      };
      if (scrollContainerId && direction) {
        addScrollPreview({ kind: "text", revealDirection: direction, ...textNode });
      } else if (textNodes.length < maxTextNodes && getVisibleClientRect(el)) {
        textNodes.push(textNode);
      }
    }
    const orderedControls = visibleControls.sort((left, right) => left.order - right.order);
    const orderedHeadings = headingNodes.sort((left, right) => left.order - right.order);
    const orderedTextNodes = textNodes.sort((left, right) => left.order - right.order);
    const orderedScrollPreviews = scrollPreviews.sort((left, right) => left.order - right.order);
    const observationTree = buildObservationTree({
      activeDialog,
      controls: orderedControls,
      headings: orderedHeadings,
      scrollContainers,
      scrollPreviews: orderedScrollPreviews,
      textNodes: orderedTextNodes,
      alerts,
      dialogBlocksBackground
    });
    return {
      url: globalThis.window.location.href,
      title: globalThis.document.title,
      ...activeDialog ? {
        activeDialog: {
          role: activeDialog.getAttribute("role") || "dialog",
          title: resolveDialogTitle(activeDialog),
          blocking: dialogBlocksBackground
        }
      } : {},
      tree: observationTree
    };
    function buildObservationTree({
      activeDialog: dialog,
      controls: treeControls,
      headings: treeHeadings,
      scrollContainers: treeScrollContainers,
      scrollPreviews: treeScrollPreviews,
      textNodes: treeTextNodes,
      alerts: treeAlerts,
      dialogBlocksBackground: blocking
    }) {
      const root = { children: [] };
      const dialogTitle = dialog ? resolveDialogTitle(dialog) : "";
      let dialogNode;
      const scrollNodes = /* @__PURE__ */ new Map();
      const contextNodeForPath = (parent, path) => {
        let node = parent;
        for (const name of path) {
          let child = node.children.find((candidate) => candidate.kind === "context" && candidate.name === name);
          if (!child) {
            child = { kind: "context", name, children: [] };
            node.children.push(child);
          }
          node = child;
        }
        return node;
      };
      const parentForPath = (path = []) => {
        if (dialogTitle && path[0] === dialogTitle) {
          if (!dialogNode) {
            dialogNode = {
              kind: "dialog",
              role: dialog.getAttribute("role") || "dialog",
              title: dialogTitle,
              blocking,
              children: []
            };
            root.children.push(dialogNode);
          }
          return { node: dialogNode, path: path.slice(1) };
        }
        return { node: root, path };
      };
      const insertScrollContainer = (container) => {
        if (scrollNodes.has(container.id)) return scrollNodes.get(container.id);
        const { node, path } = parentForPath(container.contextPath);
        const parent = contextNodeForPath(node, path);
        const scrollNode = {
          kind: "scroll",
          id: container.id,
          label: container.label,
          canScrollUp: container.canScrollUp,
          canScrollDown: container.canScrollDown,
          children: []
        };
        parent.children.push(scrollNode);
        scrollNodes.set(container.id, scrollNode);
        return scrollNode;
      };
      const entries = [
        ...treeHeadings.map((heading) => ({ kind: "heading", value: heading, order: heading.order })),
        ...treeTextNodes.map((textNode) => ({ kind: "text", value: textNode, order: textNode.order })),
        ...treeControls.map((control) => ({ kind: "control", value: control, order: control.order }))
      ].sort((left, right) => left.order - right.order);
      for (const entry of entries) {
        const item = entry.value;
        let parent;
        if (item.scrollContainerId) {
          const container = treeScrollContainers.find((candidate) => candidate.id === item.scrollContainerId);
          if (!container) continue;
          const scrollNode = insertScrollContainer(container);
          const itemPath = parentForPath(item.contextPath).path;
          const containerPath = parentForPath(container.contextPath).path;
          const relativePath = itemPath.slice(0, containerPath.length).every((part, index) => part === containerPath[index]) ? itemPath.slice(containerPath.length) : itemPath;
          parent = contextNodeForPath(scrollNode, relativePath[0] === container.label ? relativePath.slice(1) : relativePath);
        } else {
          const { node, path } = parentForPath(item.contextPath);
          parent = contextNodeForPath(node, path);
        }
        if (entry.kind === "heading") {
          parent.children.push({ kind: "heading", text: item.text, level: item.level });
        } else if (entry.kind === "text") {
          parent.children.push({ kind: "text", text: item.text });
        } else {
          const { contextPath, order, scrollContainerId, ...control } = item;
          parent.children.push({ kind: "control", ...control });
        }
      }
      for (const container of treeScrollContainers) insertScrollContainer(container);
      const previewNodes = /* @__PURE__ */ new Map();
      for (const preview of treeScrollPreviews) {
        const scrollNode = scrollNodes.get(preview.scrollContainerId);
        if (!scrollNode) continue;
        const key = `${preview.scrollContainerId}:${preview.revealDirection}`;
        let previewNode = previewNodes.get(key);
        if (!previewNode) {
          previewNode = { kind: "preview", direction: preview.revealDirection, children: [] };
          scrollNode.children.push(previewNode);
          previewNodes.set(key, previewNode);
        }
        const { order, revealDirection: revealDirection2, scrollContainerId, contextPath, ...previewItem } = preview;
        previewNode.children.push({ kind: `preview-${preview.kind}`, ...previewItem });
      }
      for (const text of treeAlerts) {
        root.children.push({ kind: "alert", text });
      }
      return root.children;
    }
  };

  // browser-extension/collector-entry.js
  (() => {
    if (globalThis.__dubloObservationWatcher) {
      globalThis.__dubloObservationWatcher.capture();
      return;
    }
    let updateTimer;
    let observationTurn = 0;
    let active = true;
    const observer = new MutationObserver(scheduleCapture);
    const observe = () => observer.observe(document.documentElement, {
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
})();
