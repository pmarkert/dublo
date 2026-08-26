# Improving Observation, Interaction, and Multi-Persona Testing

This document reviews how Dublo's AI agents currently observe and drive web
apps, and recommends changes in four areas:

1. Making observations less dependent on hand-rolled ARIA scraping.
2. Widening the interaction mechanism (actions the planner can take).
3. Turning personas into capability profiles (accessibility, regression,
   security, chaos) instead of prompt-only variations.
4. Cutting per-step cost so runs work well on low-priced models.

## Where the current design stands

The core loop (`src/utils/scenario-runner.mjs`) is solid: observe → plan one
action via a forced tool call → execute → settle → re-observe, with recoverable
error classification, scroll-loop detection, and secret redaction. The
`data-agentic-id` + turn-token targeting scheme is a good pattern — it avoids
brittle CSS selectors and stale-element bugs.

The weak point is the observation layer (`src/utils/scenario/observation.mjs`):
a custom DOM walker running in `page.evaluate` that re-implements accessible
name computation (aria-label, aria-labelledby, `<label>`, text fallback) and
relies on roles/ARIA attributes to decide what is interactive. That works on
well-built apps and silently degrades on everything else.

## 1. Observation: reduce dependence on hand-authored ARIA

### 1a. Use the browser's accessibility tree as the primary observation

Instead of re-implementing accessible-name resolution, snapshot the
accessibility tree the browser has already computed. Playwright exposes this as
`locator.ariaSnapshot()` (the same representation Playwright MCP and the
Playwright test agents use). Benefits:

- **Spec-correct names.** The browser implements the full AccName algorithm:
  `alt` text, `<svg><title>`, `title` attributes, CSS `content`, implicit
  labels, placeholder fallback — cases the current resolver misses.
- **Implicit roles for free.** A `<summary>`, `<area>`, `<option>` inside a
  listbox, or a native `<dialog>` shows up with the right role without being in
  `controlsSelector`.
- **Compact, model-friendly output.** The YAML-ish snapshot format is
  significantly cheaper in tokens than pretty-printed JSON and is a format
  current models have seen a lot of during training.

Suggested shape: keep the current structured observation as the source for
*state* (values, checked, disabled, scroll containers, modal detection — that
logic is genuinely good), but derive *what exists and what it's called* from
the aria snapshot, joining the two by element. A pragmatic first step is a new
`observationMode: "aria-snapshot" | "dom" | "hybrid"` in the observation
config so the modes can be A/B tested per app with the existing pricing report.

### 1b. Close the coverage gaps the current walker has

These are concrete blind spots in `observation.mjs` today, independent of
which representation is chosen:

- **Shadow DOM is invisible.** `document.querySelectorAll` does not pierce
  shadow roots, so any app using web components (or design systems like
  Shoelace/FAST, Salesforce LWC) produces empty observations. Recurse into
  `element.shadowRoot` in the walker, or rely on `ariaSnapshot`, which pierces
  open shadow DOM.
- **Iframes are invisible.** The walker only sees the top document. Embedded
  auth pages, payment widgets (Stripe), and rich-text editors live in frames.
  Enumerate `page.frames()` and collect per-frame observations (tag controls
  with a frame id so the executor can resolve them).
- **Non-semantic clickables are invisible.** A `<div onclick=...>` with
  `cursor: pointer` and no role never enters the control list — the agent is
  simply stuck, and on low-ARIA apps this is the common case. Add a heuristic
  interactivity tier to the walker: elements with `onclick`/`tabindex >= 0`,
  computed `cursor: pointer` (where the parent doesn't already provide it), or
  CDP-reported click listeners (`DOMDebugger.getEventListeners` via a CDP
  session; works headless in Chromium). Mark these `inferred: true` so the
  planner knows the label may be weak, and so reports can flag them as
  accessibility findings (see §3).

### 1c. Set-of-marks screenshots for vision grounding

`request_screenshot` currently sends a raw viewport image. Small multimodal
models ground far better with **set-of-marks** annotation: draw numbered boxes
over the observed controls using their `a<N>` ids before capture (a short
injected overlay, removed after screenshot). The model then answers in terms of
ids it can also see visually, which converges observation and screenshot into
one address space. This also makes a screenshot-primary mode viable for apps
whose DOM is hostile (canvas-rendered UIs, heavy obfuscation), where the
structured observation is the fallback rather than the primary.

### 1d. Free, deterministic signals in every observation

Attach zero-token-cost evidence that currently gets thrown away:

- **Console errors and `pageerror`** since the last action.
- **Failed requests and HTTP ≥ 400/500 responses** (method, URL, status).
- **Dialog events** (`page.on("dialog")`) — currently an unexpected
  `alert()`/`confirm()` will hang the run.

Surface them as `observation.runtimeErrors` (clipped) and store them per-step
in the report. This is the raw material the QA, chaos, and security personas
need, and it costs nothing.

## 2. Interaction: widen the action vocabulary

The planner can only `click`, `fill`, `select_option`, and `scroll`. Missing
actions that block whole classes of testing:

- **`press_key`** (Tab, Shift+Tab, Enter, Escape, Arrow keys) — mandatory for
  the accessibility persona (keyboard operability is the test), and the only
  way to close some overlays or operate custom widgets.
- **`hover`** — menus that open on hover are currently unreachable.
- **`navigate` / `back`** — deep links from context data and browser-back
  regression checks (does state survive back/forward?).
- **`upload_file`** (from a workspace-declared fixture allowlist, never
  arbitrary paths).

Two structural additions:

- **Focus in the observation.** Report which control is `document.activeElement`
  (`focused: true`) and whether a focus indicator is visible; without it,
  keyboard actions are blind.
- **Short action batches.** Allow the planner to return up to N (e.g. 3)
  actions per turn for high-confidence sequences (fill three fields of a form).
  The executor validates each action against the live DOM before running it and
  aborts the remainder + re-observes on any mismatch, so safety is preserved.
  This alone cuts planner calls (and cost) roughly in half on form-heavy flows,
  which is where low-cost models spend most steps.

## 3. Personas as capability profiles, not just prompts

Today a persona is only a system-prompt fragment. The accessibility persona is
told to "pay attention to missing labels" but has no keyboard actions, no axe
results, and — critically — **no way to report what it notices**: the only
terminal outputs are `finish` and `give_up`. Recommended model:

```
persona = prompt + allowed actions + instruments + finding taxonomy
```

### 3a. Add a `report_finding` action (highest-leverage change)

A non-terminal planner action:

```json
{ "action": "report_finding",
  "severity": "info|minor|major|critical",
  "category": "accessibility|usability|functional|performance|security",
  "summary": "...", "evidence": "..." }
```

The runner appends it to `report.findings` with the current URL, step index,
and screenshot, and the run continues. This converts every persona from
pass/fail into a defect generator, and it's what makes usability/accessibility
personas worth running at all. Reports gain a findings section; `qa-strict`
can be instructed to file findings instead of burying observations in `reason`
strings.

### 3b. Accessibility persona

- **Instrument:** inject axe-core after each settle (or on demand via a
  `run_audit` action) and feed the violation summary into the observation.
  axe is deterministic and free; the LLM's job shrinks to triage and to the
  judgment-based checks axe can't do (is the label *meaningful*, is the flow
  understandable) — a much better fit for a cheap model.
- **Mode:** a keyboard-only variant where `click` is disallowed and the
  persona must complete the scenario with `press_key` — failures are findings
  by definition.
- The `inferred: true` clickables from §1b are automatic findings
  ("interactive element with no role/name").

### 3c. Regression persona: record once with an LLM, replay for free

The pieces already exist: init blocks replay recorded `click`/`fill` actions
deterministically, and `block import` builds blocks from a prior run. Extend
that into a first-class mode:

1. An LLM-driven run that passes exports its full action trace (not just init
   steps) as a replayable script with expected post-conditions per step
   (URL, key document text, control states — all already captured in reports).
2. `dublo replay <trace>` re-runs it with **zero planner calls**, asserting
   post-conditions.
3. On divergence (target missing, post-condition failed), escalate that one
   step to the planner ("self-healing"): the LLM re-grounds the intent
   ("click the Submit button in the checkout form" — label/context data is in
   the trace) against the fresh observation, patches the trace, and replay
   continues.

This is the biggest cost lever for the stated goal: exploration costs LLM
tokens once; nightly regression costs ~zero until the app changes, and then
only the changed steps cost tokens.

### 3d. Security persona (authorized targets only)

Keep it clearly scoped to apps the user owns/tests under authorization — the
workspace prompt is the right place to state that scope.

- **Passive, deterministic instruments** (no LLM cost): response header checks
  (CSP, HSTS, X-Content-Type-Options), cookie flags (Secure/HttpOnly/SameSite),
  `autocomplete` on credential fields, mixed content, stack traces/verbose
  errors in `documentText`, secrets echoed into the DOM (the redaction map
  already knows the values to look for).
- **LLM-driven checks that fit the existing loop:** canary inputs in `fill`
  values (e.g. a marker string with markup) with a detector that watches
  `documentText`, alerts, and `runtimeErrors` for the marker reflected
  unescaped, for a triggered JS error, or for a server 500 — reported through
  `report_finding` with `category: "security"`. Keep this to reflection- and
  error-surfacing probes; anything that mutates or exfiltrates data is out of
  scope for an automated UX agent.

### 3e. Chaos persona: cheap, seeded, reproducible

Chaos testing does not need a smart model to choose the next click — it needs
coverage and repeatability. Drive it from a **seeded pseudo-random walk** over
the observed controls, biased toward under-exercised areas, with occasional
junk input into fields (empty, huge, unicode, markup). Reserve the LLM only to
*judge* whether a resulting state looks broken (blank screen, stuck spinner,
dead-end, uncaught error) and to file findings. The seed makes any crash
replayable exactly. Because the `runtimeErrors` signal from §1d is
deterministic, most chaos findings need no model judgment at all — the model is
a triage layer, not the driver, which keeps it viable on the cheapest models.

## 4. Cutting per-step cost for low-priced models

The loop already does the important things right — a forced structured tool
call, a compact observation, deterministic init blocks, and a static/dynamic
message split. Two gaps remain, in impact order:

- **Prompt caching is tracked but never engaged.** The pricing layer counts
  `cacheReadInputTokens` / `cacheWriteInputTokens`, and `buildPlannerMessages`
  already separates `staticContextText` from `dynamicContextText` — but the
  Bedrock request in `src/node/bedrock-planner.ts` never inserts a `cachePoint`
  block, so the large unchanging prefix (system prompt, persona, scenario,
  planning rules) is re-billed at the full input rate on every step. Inserting
  a `cachePoint` after the static content is a few lines and is the single
  biggest cost lever for the stated goal. The prefix already sits before the
  dynamic half and is byte-stable across turns, so it is cache-ready today.
- **The dynamic half re-sends more than it needs.** Diff the observation
  (send changed controls rather than the full list when little moved), cap the
  growth of `recentActions` / `completedWork` with a rolling window plus a
  short running summary, and drop redundant control fields (e.g. `ariaLabel`
  when it equals `label`).

Layered on top of the structural items above, these compound: caching cuts the
per-step input cost, action batches (§2) and the regression replay mode (§3c)
cut the *number* of planner calls, and the deterministic instruments (axe,
header/cookie checks, `runtimeErrors`) move whole categories of judgment off
the model entirely.

- **Two-tier model routing.** Most steps are unambiguous. Drive them with the
  cheapest capable model and escalate to a stronger profile only on `give_up`,
  a recovered action failure, a truncated observation, or low confidence. The
  LLM config already supports multiple profiles; this needs only an optional
  `escalationLlm` and a trigger policy.

## Suggested order of work

Ranked by value-to-effort:

1. **Engage prompt caching (`cachePoint`).** Mechanical, run-wide, no behavior
   change — the enabler for low-priced models.
2. **Capture `runtimeErrors` (console, `pageerror`, failed responses, dialogs).**
   One hook each; unlocks real oracles for QA, chaos, and security at zero
   model cost.
3. **Add `report_finding`.** Turns every persona from pass/fail into a defect
   generator; prerequisite for the usability/accessibility personas to be
   worth running.
4. **Widen the action vocabulary (`press_key`, `hover`, `navigate`) and report
   focus state.** Needed for keyboard/accessibility testing and stuck overlays.
5. **Close observation blind spots (shadow DOM, iframes, inferred clickables)**
   and/or adopt `ariaSnapshot` as a hybrid observation mode.
6. **Regression replay with self-healing** and short action batches — the
   largest sustained cost savings once flows are proven.
7. **Set-of-marks screenshots and two-tier routing** — final grounding and
   cost polish once the loop and personas have settled.

## Implementation status

Items 1–4 are implemented:

- **Prompt caching** — `promptCaching` on the Bedrock LLM profile inserts cache
  points after the system prompt and static context (`src/node/bedrock-planner.ts`).
- **Runtime signals** — console errors, uncaught exceptions, failed/`>= 400`
  responses, failed requests, and auto-dismissed native dialogs are captured
  each step (`src/utils/scenario/runtime-errors.mjs`), shown to the planner, and
  recorded in reports; secrets embedded in signal text are masked.
- **`report_finding`** — a non-terminal action that records severity/category/
  summary/evidence into `report.findings`, rendered in the HTML and Markdown
  reports.
- **Action vocabulary + focus** — `press_key`, `hover`, `navigate` (same-origin),
  and `go_back`, plus focus state on the observation (`observation.focus` and a
  per-control `focused` flag).

Items 5–7 (observation blind spots / `ariaSnapshot`, regression replay with
self-healing and action batches, set-of-marks screenshots and two-tier routing)
remain open.