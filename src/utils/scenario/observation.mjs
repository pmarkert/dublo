export async function collectObservation(page, observationConfig, turnToken) {
  return page.evaluate(({ config, turnToken: activeTurnToken }) => {
    const cfg = config && typeof config === "object" ? config : {};

    const controlsSelector =
      typeof cfg.controlsSelector === "string" && cfg.controlsSelector.trim().length > 0
        ? cfg.controlsSelector
        : "button, a, input, textarea, select, [role='button'], [role='link'], [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']";
    // 0 (or negative) means no limit; otherwise a positive cap. Controls are
    // ranked by relevance before this cap is applied, so the most useful ones
    // survive truncation.
    const maxControls = Number.isFinite(cfg.maxControls)
      ? Number(cfg.maxControls) <= 0
        ? Infinity
        : Number(cfg.maxControls)
      : 150;
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

    // FNV-1a: a short, deterministic, dependency-free digest. Used only for
    // control fingerprints, which are recorded in artifacts and never shown to
    // the planner, so this needs to be stable across runs - not cryptographic.
    const hashString = (value) => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    };

    // Identity of a control in terms that survive a re-render and a new run:
    // what kind of control it is, its accessible name, and where it sits in the
    // page structure. Deliberately excludes per-turn ids, live values, and
    // transient state. Repeated rows (50 identical "Delete" buttons) share a
    // fingerprint by design; that costs drift-detection sensitivity for those
    // controls but never mis-targets anything, because fingerprints are not
    // used to address controls.
    const computeFingerprint = (parts) =>
      hashString(parts.map((part) => normalizeText(part).toLowerCase()).join("|"));

    const resolveReferencedText = (ids) =>
      ids
        .split(/\s+/)
        .map((id) => globalThis.document.getElementById(id))
        .map((element) => normalizeText(element?.innerText || element?.textContent || ""))
        .filter(Boolean)
        .join(" · ");

    const pierceShadow = cfg.pierceShadow !== false;

    const queryAllWithin = (root, selector) => {
      if (!pierceShadow) {
        try {
          return Array.from(root.querySelectorAll(selector));
        } catch {
          return [];
        }
      }

      // Descend into open shadow roots so web-component UIs (which are invisible
      // to a plain querySelectorAll) still surface their controls. Playwright's
      // locator engine pierces open shadow DOM too, so the data-agentic-id
      // targets set below remain clickable.
      const results = [];
      const seen = new Set();
      const visit = (node) => {
        let matches = [];
        try {
          matches = Array.from(node.querySelectorAll(selector));
        } catch {
          matches = [];
        }
        for (const el of matches) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }

        let descendants = [];
        try {
          descendants = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
        } catch {
          descendants = [];
        }
        for (const el of descendants) {
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(root);
      return results;
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

    // Resolves an accessible-ish name plus the source it came from. Beyond the
    // ARIA/label chain, it falls back to title, control value, embedded image
    // alt text, and inline SVG <title>, so icon-only and lightly-authored
    // controls still get a usable name. nameSource lets callers judge how much
    // to trust it (an unnamed interactive control is itself an a11y finding).
    const resolveControlNameWithSource = (el, textSegments) => {
      const labelledBy = resolveReferencedText(el.getAttribute("aria-labelledby") || "");
      if (labelledBy) return { name: labelledBy, source: "aria-labelledby" };

      const ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
      if (ariaLabel) return { name: ariaLabel, source: "aria-label" };

      if ("labels" in el && el.labels?.length) {
        const labels = Array.from(el.labels)
          .map((label) => normalizeText(label.innerText || label.textContent || ""))
          .filter(Boolean)
          .join(" · ");
        if (labels) return { name: labels, source: "label" };
      }

      const id = el.getAttribute("id") || "";
      const associatedLabel = id
        ? normalizeText(globalThis.document.querySelector(`label[for='${globalThis.CSS.escape(id)}']`)?.innerText || "")
        : "";
      if (associatedLabel) return { name: associatedLabel, source: "label" };

      if (textSegments[0]) return { name: textSegments[0], source: "text" };

      const ownText = normalizeText(el.innerText || el.textContent || "");
      if (ownText) return { name: ownText, source: "text" };

      const title = normalizeText(el.getAttribute("title") || "");
      if (title) return { name: title, source: "title" };

      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "button") {
        const value = normalizeText(el.getAttribute("value") || "");
        if (value) return { name: value, source: "value" };
      }

      const imageAlt = queryAllWithin(el, "img[alt]")
        .map((img) => normalizeText(img.getAttribute("alt") || ""))
        .find(Boolean);
      if (imageAlt) return { name: imageAlt, source: "alt" };

      const svgTitle = queryAllWithin(el, "svg title")
        .map((node) => normalizeText(node.textContent || ""))
        .find(Boolean);
      if (svgTitle) return { name: svgTitle, source: "svg-title" };

      const placeholder = normalizeText(el.getAttribute("placeholder") || "");
      if (placeholder) return { name: placeholder, source: "placeholder" };

      return { name: "", source: "none" };
    };

    const NAME_CONFIDENCE = {
      "aria-labelledby": "high",
      "aria-label": "high",
      label: "high",
      text: "medium",
      title: "low",
      value: "low",
      alt: "low",
      "svg-title": "low",
      placeholder: "low",
      none: "none",
    };

    const resolveControlName = (el, textSegments) => resolveControlNameWithSource(el, textSegments).name;

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
      // For elements inside an open shadow root, document.elementFromPoint
      // retargets to the shadow host, so also probe within the element's own
      // root and treat a hit anywhere in its shadow subtree as clickable.
      const rootNode = el.getRootNode();
      const pointRoots = [globalThis.document];
      if (rootNode && rootNode !== globalThis.document && typeof rootNode.elementFromPoint === "function") {
        pointRoots.push(rootNode);
      }

      for (const pointRoot of pointRoots) {
        const topEl = pointRoot.elementFromPoint(cx, cy);
        if (!topEl) continue;

        if (topEl === el || el.contains(topEl)) {
          return true;
        }

        // A shadow host sitting over the element counts when the element lives
        // in that host's shadow tree.
        if (topEl.shadowRoot && topEl.shadowRoot.contains(el)) {
          return true;
        }

        const topLabel = typeof topEl.closest === "function" ? topEl.closest("label") : null;
        if (topLabel && "control" in topLabel && topLabel.control === el) {
          return true;
        }
      }

      return false;
    };

    // interactionScope decides whether controls that are rendered but scrolled
    // out of the viewport are surfaced. "viewport" (default) mirrors what a user
    // can currently reach; "document" also includes reachable off-viewport
    // controls (Playwright auto-scrolls them into view on click/fill).
    const interactionScope = cfg.interactionScope === "document" ? "document" : "viewport";

    const isReachableOffscreen = (el) => {
      // Only relevant for elements not currently in the viewport; in-viewport
      // elements are judged by isLayerClickable (which also detects occlusion).
      if (getVisibleClientRect(el)) return false;
      if (!isVisible(el)) return false;
      try {
        if (el.closest('[aria-hidden="true"], [inert]')) return false;
      } catch {
        // ignore malformed selectors / detached nodes
      }
      const style = globalThis.window.getComputedStyle(el);
      if (style.pointerEvents === "none") return false;
      const rect = el.getBoundingClientRect();
      // Exclude 1px "visually hidden" screen-reader-only text.
      if (rect.width < 2 && rect.height < 2) return false;
      return true;
    };

    const isDisabledControl = (el) => {
      if ("disabled" in el && el.disabled === true) return true;
      return el.getAttribute("aria-disabled") === "true";
    };

    const isNativeInteractive = (el) => {
      try {
        return el.matches(controlsSelector);
      } catch {
        return false;
      }
    };

    // A disabled control is unclickable, so every clickability probe above
    // rejects it - component libraries routinely set `pointer-events: none` on
    // the disabled state (shadcn/ui's default button does, via
    // `disabled:pointer-events-none`), which also defeats the hit test.
    // Dropping it is wrong: a disabled submit button is usually the most
    // informative control on a form, because its state IS the reason the flow
    // is blocked, and its text still appears in documentText - so the model
    // sees a control advertised in one field and absent from another, and
    // guesses. Surface visible, semantically-interactive disabled controls and
    // let the `disabled` flag carry the meaning; the executor still refuses to
    // click them, which is what produces the `disabled_target` feedback.
    // Deliberately NOT extended to inferred/non-semantic clickables, where
    // pointer-events:none remains a sound signal for decorative or inert layers.
    const isObservableDisabledControl = (el) => {
      if (!isDisabledControl(el)) return false;
      if (!isNativeInteractive(el)) return false;
      if (!isVisible(el)) return false;
      try {
        if (el.closest('[aria-hidden="true"], [inert]')) return false;
      } catch {
        // ignore malformed selectors / detached nodes
      }
      // Respect interactionScope: only surface an off-screen disabled control
      // when the run is observing the whole document.
      return Boolean(getVisibleClientRect(el)) || interactionScope === "document";
    };

    const isSelectableControl = (el) =>
      isActiveOverlayControl(el) ||
      isLayerClickable(el) ||
      isObservableDisabledControl(el) ||
      (interactionScope === "document" && isReachableOffscreen(el));

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

    // Relevance scoring so the maxControls budget keeps the useful controls
    // instead of whatever comes first in the DOM: in-viewport controls rank
    // highest, then the nearest off-viewport ones, with a boost for controls
    // whose text matches the run's relevance keywords.
    const relevanceKeywords = Array.isArray(cfg.relevanceKeywords)
      ? cfg.relevanceKeywords
          .filter((keyword) => typeof keyword === "string" && keyword.trim().length > 0)
          .map((keyword) => keyword.toLowerCase())
      : [];
    const viewportHeight = globalThis.window.innerHeight || 0;
    const viewportWidth = globalThis.window.innerWidth || 0;
    const controlRelevanceScore = (el) => {
      const rect = el.getBoundingClientRect();
      let score = 0;
      const inViewport =
        rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
      if (inViewport) score += 1_000_000;
      const distanceY =
        rect.top >= viewportHeight
          ? rect.top - viewportHeight
          : rect.bottom <= 0
            ? -rect.bottom
            : 0;
      score -= Math.min(Math.max(distanceY, 0), 900_000);
      if (relevanceKeywords.length > 0) {
        const haystack = normalizeText(
          `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("title") || ""}`
        ).toLowerCase();
        if (relevanceKeywords.some((keyword) => haystack.includes(keyword))) score += 500_000;
      }
      return score;
    };

    const priorityElements = [];
    const generalCandidates = [];
    const inferredCandidates = [];
    const seenElements = new Set();
    let controlsTruncated = false;

    // Tier 1: active overlay controls and priority selectors are always kept.
    for (const el of overlayControls) {
      if (seenElements.has(el)) continue;
      if (!isVisible(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      priorityElements.push({ el, priority: true });
    }
    for (const selector of priorityControlSelectors) {
      for (const el of queryAllInteractionRoots(selector)) {
        if (seenElements.has(el)) continue;
        if (!isVisible(el)) continue;
        if (!isSelectableControl(el)) continue;
        if (shouldIgnoreControl(el)) continue;
        seenElements.add(el);
        priorityElements.push({ el, priority: true });
      }
    }

    // Tier 2: general controls — collect every eligible one, rank below.
    for (const el of queryAllInteractionRoots(controlsSelector)) {
      if (seenElements.has(el)) continue;
      if (!isVisible(el)) continue;
      if (!isSelectableControl(el)) continue;
      if (shouldIgnoreControl(el)) continue;
      seenElements.add(el);
      generalCandidates.push(el);
    }

    // Tier 3: non-semantic clickables that carry no role/tag the selector above
    // would catch (a <div onclick>, a keyboard-focusable card, a cursor:pointer
    // tile). Common on lightly authored apps where the agent would otherwise be
    // stuck. Marked inferred so downstream can treat their names as low
    // confidence and flag them as accessibility issues.
    const includeInferredControls = cfg.includeInferredControls !== false;
    const maxInferredControls = Number.isFinite(cfg.maxInferredControls)
      ? Math.max(0, Number(cfg.maxInferredControls))
      : 20;
    if (includeInferredControls && maxInferredControls > 0) {
      const isNativeControl = (el) => {
        try {
          return el.matches(controlsSelector);
        } catch {
          return false;
        }
      };
      const wrapsAControl = (el) =>
        queryAllWithin(el, controlsSelector).some((child) => isVisible(child));
      const considerInferred = (el, hasExplicitSignal) => {
        if (seenElements.has(el)) return;
        if (!isVisible(el)) return;
        if (isNativeControl(el)) return;
        if (!isSelectableControl(el)) return;
        if (shouldIgnoreControl(el)) return;
        if (wrapsAControl(el)) return;
        if (!hasExplicitSignal) {
          // Cursor-based candidates are noisier, so require short, direct text.
          const text = normalizeText(el.innerText || el.textContent || "");
          if (!text || text.length > 60) return;
        }
        seenElements.add(el);
        inferredCandidates.push(el);
      };

      for (const el of queryAllInteractionRoots("[onclick], [tabindex]")) {
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) < 0 && !el.hasAttribute("onclick")) continue;
        considerInferred(el, true);
      }
      for (const el of queryAllInteractionRoots("*")) {
        if (seenElements.has(el)) continue;
        let cursor = "";
        try {
          cursor = globalThis.window.getComputedStyle(el).cursor;
        } catch {
          cursor = "";
        }
        if (cursor !== "pointer") continue;
        considerInferred(el, false);
      }
    }

    // Rank the general and inferred tiers, then apply the budget. Priority
    // controls are always kept; the remaining budget is filled with the most
    // relevant general controls, then the most relevant inferred ones (capped).
    const rankedGeneral = generalCandidates
      .map((el) => ({ el, score: controlRelevanceScore(el) }))
      .sort((left, right) => right.score - left.score);
    const rankedInferred = inferredCandidates
      .map((el) => ({ el, score: controlRelevanceScore(el) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, maxInferredControls);

    const selectedElements = [...priorityElements];
    for (const { el } of rankedGeneral) {
      if (selectedElements.length >= maxControls) {
        controlsTruncated = true;
        break;
      }
      selectedElements.push({ el, priority: false });
    }
    for (const { el } of rankedInferred) {
      if (selectedElements.length >= maxControls) {
        controlsTruncated = true;
        break;
      }
      selectedElements.push({ el, priority: false, inferred: true });
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
    const visibleControls = selectedElements.map(({ el, priority, inferred }) => {
      sequence += 1;
      const agenticId = `a${sequence}`;
      el.setAttribute("data-agentic-id", agenticId);
      el.setAttribute("data-agentic-turn", activeTurnToken);
      const offscreen = !getVisibleClientRect(el);

      const tag = el.tagName.toLowerCase();

      const allOptions = tag === "select"
        ? Array.from(/** @type {HTMLSelectElement} */ (el).options)
            .map((option) => ({
              label: normalizeText(option.label || option.textContent || ""),
              value: option.value,
              ...(option.selected ? { selected: true } : {}),
              ...(option.disabled ? { disabled: true } : {})
            }))
            .filter((option) => option.label || option.value)
        : [];
      const options = allOptions.slice(0, maxOptionsPerControl);
      const optionsTruncated = allOptions.length > options.length;

      const textSegments = leafTextSegments(el);
      // A select's inner text is its option labels, so derive text from the
      // SAME sliced options the model is shown; otherwise text would advertise
      // options that options[] (the validated surface) does not carry.
      const text = tag === "select"
        ? options.map((option) => option.label || option.value).join(" · ")
        : textSegments.join(" · ") || normalizeText(el.innerText || el.textContent || "");
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const role = el.getAttribute("role") || "";
      const type = el.getAttribute("type") || "";
      const { name: label, source: nameSource } = resolveControlNameWithSource(el, textSegments);
      const confidence = NAME_CONFIDENCE[nameSource] || "none";
      const description = resolveReferencedText(el.getAttribute("aria-describedby") || "");
      const contextPath = resolveContextPath(el, scopeRoot);
      // Recorded-only stable identity (see computeFingerprint).
      const fingerprint = computeFingerprint([tag, role, type, label, contextPath.join(">")]);
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

      return {
        id: agenticId,
        tag,
        role,
        type,
        priority,
        ...(inferred ? { inferred: true } : {}),
        text,
        ariaLabel,
        label,
        nameSource,
        confidence,
        ...(description ? { description } : {}),
        contextPath,
        fingerprint,
        placeholder,
        ...(value ? { value } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(optionsTruncated ? { optionsTruncated: true, optionCount: allOptions.length } : {}),
        hasValue,
        checked,
        ...(el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? { required: true } : {}),
        ...(el.getAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
        ...(el.getAttribute("aria-selected") ? { selected: el.getAttribute("aria-selected") === "true" } : {}),
        ...(el.getAttribute("aria-pressed") ? { pressed: el.getAttribute("aria-pressed") === "true" } : {}),
        ...(el.getAttribute("aria-current") ? { current: el.getAttribute("aria-current") } : {}),
        ...(el.getAttribute("aria-invalid") === "true" ? { invalid: true } : {}),
        ...(disabled ? { disabled: true } : {}),
        ...(el === globalThis.document.activeElement ? { focused: true } : {}),
        ...(offscreen ? { offscreen: true } : {}),
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

    const activeElement = globalThis.document.activeElement;
    const hasFocus =
      activeElement &&
      activeElement !== globalThis.document.body &&
      activeElement !== globalThis.document.documentElement;
    const focus = hasFocus
      ? {
          tag: activeElement.tagName.toLowerCase(),
          ...(activeElement.getAttribute("role") ? { role: activeElement.getAttribute("role") } : {}),
          label: resolveControlName(activeElement, leafTextSegments(activeElement)),
        }
      : null;

    return {
      url: globalThis.window.location.href,
      title: globalThis.document.title,
      focus,
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
      ...(controlsTruncated ? { truncated: true, maxControls } : {}),
    };
  }, { config: observationConfig, turnToken });
}
