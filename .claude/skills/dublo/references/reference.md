# Dublo reference

Exhaustive reference for operating Dublo. Pair with `../SKILL.md` (mental model
and recipes). Where a default is given, it is the value used when nothing is set.

---

## 1. CLI commands

Global option on almost every command: `--workspace <path>` (default
`DUBLO_WORKSPACE` or `./.dublo`).

### Setup

- `dublo init [--workspace <path>] [--base-url <url>] [--force]` — create a
  workspace: `defaults.json` + folders `llm/ personas/ scenarios/ context/
  blocks/`. Refuses to overwrite existing defaults without `--force`.
- `dublo completion <bash|zsh|fish>` — print a shell completion script.
- `dublo skill install [--target <dir>] [--user] [--force]` — copy this bundled
  skill into a Claude Code skills directory (default `./.claude/skills`;
  `--user` → `~/.claude/skills`). Refuses to overwrite an existing install
  without `--force`; re-run with `--force` to update after upgrading dublo.
- `dublo skill show` — print this skill's `SKILL.md` to stdout.

### Running

```
dublo run [scenario] [options]
```
Resolves the scenario from (in order): positional `[scenario]` / `--scenario`
(file path or name under `scenarios/`), `--adhoc "<text>"`, or **stdin** if
neither is given. Options:

| Option | Meaning |
| --- | --- |
| `--llm <value>` | LLM profile file path or name under `llm/` |
| `--escalation-llm <value>` | Stronger LLM profile to switch to on failure/truncation/`give_up` |
| `--persona <value>` | Persona file path, workspace persona name, or built-in template name |
| `--scenario <value>` | Scenario file path or name under `scenarios/` |
| `--adhoc <text>` | Inline scenario text (no file) |
| `--headless` | Run Chromium headless (default is headed) |
| `--debug` | Verbose logging + per-step HTML dumps in the report |
| `--open` | Open the generated HTML report when finished |
| `--init <block>` | Replay a reusable init block before planner actions (repeatable) |
| `--context <value>` | Context file path or name under `context/` (repeatable) |
| `--set <key.path=value>` | Inline context assignment (repeatable) |
| `--json <object>` | Inline JSON object merged into context (repeatable) |
| `--secret <path=ENV_VAR>` | Environment-backed secret for `{{secret:path}}` (repeatable) |

`--context`, `--set`, `--json`, `--secret` are applied strictly in the order
given on the command line.

### Configuration (`defaults.json`)

- `dublo config show [--effective] [--workspace …]` — print persisted defaults;
  `--effective` prints the resolved non-secret config and the source of each
  value.
- `dublo config edit` — open `defaults.json` in `$VISUAL`/`$EDITOR` (or read
  JSON from stdin when non-interactive).
- `dublo config set <setting> <value>` / `dublo config unset <setting>` — see
  the settable keys below.
- `dublo config validate` — validate the workspace config.
- `dublo config context add|remove|clear <name>` — manage default context list.
- `dublo config report add|remove|clear <markdown|html>` — manage default report
  renderers.
- `dublo config prompt edit|show` — edit/print `<workspace>/prompt.md`
  (app-specific background injected into every run's system prompt).

**`config set` keys:** `base-url`, `llm`, `escalation-llm`, `persona`,
`max-steps`, `max-actions-per-turn`, `settle-delay-ms`, `settle-timeout-ms`,
`headless`, `screenshots`, `debug`, `output-dir`, `observation-config`.

### LLM profiles

- `dublo llm config [profile] [options]` — interactive wizard (choose a
  recommended Bedrock model for the region or enter any custom model id).
  Non-interactive: `--region`, `--model-id`, `--inference-profile <global|us>`,
  `--service-tier <default|priority|flex|reserved>`, `--set-default`, `-y/--yes`.
- `dublo llm list` — list profiles.
- `dublo llm show [profile] [--name <profile>]` — print a profile.
- `dublo llm validate [profile] [--name <profile>]` — validate a profile.

### Personas / scenarios / context

- `dublo persona list|show <name>|edit <name>` — built-in templates
  (`qa-strict`, `exploratory`, `accessibility`, `performance`) appear alongside
  workspace personas; `edit` a template seeds a workspace copy.
- `dublo scenario list|show <name>|edit <name>` — built-in templates
  (`homepage-smoke`, `login-happy-path`, `checkout-happy-path`) + workspace
  scenarios.
- `dublo context list|show <name>|edit <name> [--yaml|--json]` and
  `dublo context validate [name] [--name <name>]`.

### Blocks (recorded flows / regression replay)

- `dublo block import <name> [run-id]` — build a reusable block from a **passed**
  run (defaults to the latest). Records replayable `click`/`fill`/
  `wait_until_gone` steps with **descriptive** targets (label/text/role/type,
  not ephemeral ids) plus a URL post-condition (`expect.urlIncludes`).
- `dublo block list|show <name>|edit <name>` and
  `dublo block validate [name]`.
- Replay with `dublo run <scenario> --init <name>`. On replay a recorded target
  that no longer resolves **self-heals**: the planner re-grounds it to the
  equivalent control and continues; the URL post-condition fails the run loudly
  on divergence. Self-heal calls are counted in `tokenUsage.selfHealCalls`.

### Reports

- `dublo report list` — list saved reports.
- `dublo report show [run-id]` / `open [run-id]` / `render [run-id]` — default to
  the run named by `<output-dir>/latest.json`.

---

## 2. Configuration precedence

For every non-secret setting:

```
CLI option  >  DUBLO_* env var  >  <workspace>/defaults.json  >  built-in default
```

Selector fallback (`--llm`, `--persona`, `--scenario`, `--context`): a matching
file path wins; otherwise a profile name under the type's folder; `--context`
repeats and merges in order (later keys override earlier). If a single profile
file exists in a folder, it is used automatically.

### `defaults.json` fields

`baseUrl`, `llm`, `escalationLlm`, `persona`, `context` (string or array),
`maxSteps`, `maxActionsPerTurn`, `settleDelayMs`, `settleTimeoutMs`, `headless`,
`screenshots` (`none`|`viewport`|`fullpage`), `reports` (array of
`markdown`|`html`), `debug`, `outputDir`, `observationConfigFile`.

### Runtime defaults

`maxSteps: 40`, `maxActionsPerTurn: 0` (unlimited), `settleDelayMs: 500`,
`settleTimeoutMs: 3000`, `headless: false`, `screenshots: none`,
`outputDir: ./reports`. Settle = stable-UI debounce before each observation:
wait until the control signature is unchanged for `settleDelayMs`, up to
`settleTimeoutMs`.

---

## 3. LLM profiles (`<workspace>/llm/<name>.json`)

### Bedrock (default provider)

```json
{
  "provider": "bedrock",
  "region": "us-east-1",
  "modelId": "amazon.nova-pro-v1:0",
  "inferenceConfig": { "temperature": 0 },
  "additionalModelRequestFields": {},
  "serviceTier": "default",
  "promptCaching": true,
  "supportsStrictToolUse": false,
  "supportsConditionalToolSchemas": false,
  "inputPrice": 0.8,
  "outputPrice": 3.2,
  "cacheReadPrice": 0.2,
  "cacheWritePrice": 0,
  "currency": "USD",
  "tokenUnit": 1000000
}
```

- `promptCaching` (default `false`): insert cache points after the system prompt
  and the static planner context so the run-stable prefix is read from cache
  each step. Enable on models that support Bedrock prompt caching (Nova,
  Anthropic Claude on Bedrock). Below-threshold prefixes are ignored, so it is
  safe to enable. Biggest cost lever.
- `serviceTier`: `default|priority|flex|reserved` (models that support it).
- `supportsStrictToolUse`: use strict tool schemas and ID-only target selectors.
- `inputPrice`/`outputPrice`/`cacheReadPrice`/`cacheWritePrice`: price per
  `tokenUnit` (default `1000000`) in `currency`. If input/output prices are
  absent, cost estimation is skipped.

### Bedrock model IDs (Converse runtime)

Dublo calls the classic `bedrock-runtime` Converse API, whose catalog IDs are
**not** the Anthropic first-party IDs. Do not invent IDs from other naming
schemes — every one of these is verified against AWS's model cards:

| Model | Base catalog ID | Use in `modelId` |
| --- | --- | --- |
| Claude Sonnet 5 | `anthropic.claude-sonnet-5` | `global.anthropic.claude-sonnet-5` or `us.anthropic.claude-sonnet-5` |
| Claude Sonnet 4.6 | `anthropic.claude-sonnet-4-6` | `global.anthropic.claude-sonnet-4-6` or `us.anthropic.claude-sonnet-4-6` |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | `global.` / `us.` + base ID |
| Claude Haiku 4.5 | `anthropic.claude-haiku-4-5-20251001-v1:0` | `global.` / `us.` + base ID |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` | as-is (no profile needed) |
| Amazon Nova 2 Lite | `amazon.nova-2-lite-v1:0` | `us.` / `global.` + base ID |

Rules that trip people up:

- **Claude Sonnet 5 and Sonnet 4.6 exist on Bedrock** and use short IDs with
  **no date suffix and no `-v1:0`** (`anthropic.claude-sonnet-5`). Older Claude
  models keep the dated `-v1:0` form. Never mix the schemes — a hand-built
  `anthropic.claude-sonnet-5-v1:0` or date-suffixed Sonnet 5 ID does not exist,
  and Bedrock's "model not found" for such an ID does NOT mean the model is
  unavailable.
- **Recent Claude models require an inference-profile prefix** (`us.`, `eu.`,
  `au.`, or `global.`) — the bare base ID is not invocable on-demand in-region.
  Prefer `global.` (routes anywhere) or your geo (`us.`). The `dublo llm
  config` wizard applies the prefix when you pick a catalog model.
- Sonnet 5 rejects sampling parameters — leave `inferenceConfig` empty (no
  `temperature`) for it. Sonnet 4.6 and earlier accept `temperature: 0`.
- Set `supportsStrictToolUse: true` for Claude models on Bedrock;
  `supportsConditionalToolSchemas: true` is Nova-only.

### OpenAI-compatible (local / self-hosted)

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "modelId": "llama3.2-vision",
  "apiKey": "optional"
}
```

For vision (screenshots / set-of-marks) use a multimodal model
(`llama3.2-vision`, `gemma3`, `minicpm-v`). Prompt caching is Bedrock-only.

### Two-tier routing (escalation)

Set `escalationLlm` to a second profile name (or `--escalation-llm` /
`DUBLO_ESCALATION_LLM`). It drives a turn when the primary hits a recoverable
failure or a truncated observation, and rescues a `give_up` by retrying once
with the stronger model. Escalation calls are counted in
`tokenUsage.escalationCalls`; cost is still estimated at the primary's rates.

A schema-invalid planner turn is never fatal on its own: the runner retries
once on the same model with the validation error fed back, then (when
`escalationLlm` is set) once more on the stronger model, before failing the
run. Repair retries are counted in `tokenUsage.formatRetries`.

---

## 4. Personas

A persona is a Markdown/text file describing behavior and what to treat as a
defect. Built-ins:

- `qa-strict` — verify expected results explicitly, treat unexpected alerts /
  validation errors / missing states as failures, be conservative about
  declaring success.
- `exploratory` — follow intuitive flows, investigate surprising behavior, note
  friction and confusing wording.
- `accessibility` — attend to labeling, focus behavior, keyboard affordances,
  semantic structure; treat missing labels / focus traps / inaccessible dialogs
  as defects. Pairs with `nameSource`/`confidence` on controls and the turn's
  `findings` annotation.
- `performance` — notice slow transitions, repeated loading, delayed feedback,
  stalled UI; pairs with `runtimeErrors` and settle behavior.

Custom personas live in `<workspace>/personas/*.md`.

---

## 5. Scenarios, context, and secrets

### Scenario sources

Workspace file, built-in template (`homepage-smoke`, `login-happy-path`,
`checkout-happy-path`), `--adhoc "<text>"`, or stdin. Write the objective **and
its success criteria** in plain language.

### Context (non-secret data)

- `--context <file|name>` (repeatable, merged in order), `--set key.path=value`
  (`true`/`false`/`null`/numbers parsed; else string), `--json '{...}'`.
- Fill a control with `{{context:path}}`. Human-provided values use
  `{{input:key}}` (from `request_user_input`).
- Env: `DUBLO_CONTEXT` (comma-separated names).

### Secrets (never sent to the planner)

- `--secret context.path=ENV_VAR` reads the value from `ENV_VAR`;
  `--secret context.path` requires `DUBLO_SECRET_context__path`.
- `DUBLO_SECRET_<path>` auto-discovers a secret (use `__` for dots, e.g.
  `DUBLO_SECRET_checkout__token` → `checkout.token`).
- The planner receives the available secret **paths**, not values, and fills a
  control with `{{secret:path}}`. Exact secret strings are masked to `*******`
  in observations, and secret substrings inside `runtimeErrors` are scrubbed.
  A missing/empty referenced secret fails the run before the browser starts.
- Screenshots may still reveal secrets rendered on screen — use
  `--screenshots none` when that disclosure is unacceptable.

---

## 6. Observation config

Point at a JSON file via `--observation-config` handling
(`config set observation-config <file>` / `observationConfigFile` /
`DUBLO_OBSERVATION_CONFIG_FILE`). Fields (defaults shown):

| Field | Default | Meaning |
| --- | --- | --- |
| `controlsSelector` | buttons/links/inputs/roles | CSS for interactive controls |
| `maxControls` | `150` | Max controls per observation; **`0` = unlimited**. Controls are relevance-ranked before truncation |
| `relevanceKeywords` | `[]` | Lowercase keywords that boost matching controls when ranking; the runner seeds these from the scenario if unset |
| `priorityControlSelectors` | nav selectors | Always-kept controls |
| `ignoreControlSelectors` | devtools button | Controls to drop |
| `ignoreControlTextPatterns` | `[]` | Regex/text patterns to drop |
| `headingSelector` / `maxHeadings` | `h1,h2,h3` / `10` | Headings surfaced |
| `alertSelector` / `maxAlerts` | `[role=alert]` / `6` | Alerts surfaced |
| `documentTextScopeSelectors` | `main,[role=main]` | Where visible text is read |
| `documentTextExcludeSelectors` | devtools | Excluded from visible text |
| `documentTextMaxChars` | `2400` | Visible-text cap |
| `pierceShadow` | `true` | Descend into open shadow DOM |
| `includeInferredControls` | `true` | Surface non-semantic clickables (`[onclick]`, `[tabindex]`, short-text `cursor:pointer`), flagged `inferred` |
| `maxInferredControls` | `20` | Cap on inferred controls |
| `interactionScope` | `viewport` | `viewport` = only in-view controls; `document` = also rendered-but-off-viewport controls, flagged `offscreen` (Playwright auto-scrolls on click/fill). Keep `viewport` for usability/accessibility runs |

### What an observation contains

Top level: `url`, `title`, `focus` ({tag, role?, label} of the active element),
`modal` ({open, blocksBackground, role, ariaModal, title}), `headings`,
`alerts`, `documentText`, `scrollContainers` ([{id, contextPath, canScrollUp,
canScrollDown}]), `controls`, `runtimeErrors` (see §8), and `truncated`
(+`maxControls`) when the control cap dropped controls.

Per control: `id` (`a1`, `a2`, … — ephemeral, per-turn), `tag`, `role`, `type`,
`priority`, `inferred`, `text`, `label`, `nameSource`
(aria-labelledby|aria-label|label|text|title|value|alt|svg-title|placeholder|none),
`confidence` (high|medium|low|none), `ariaLabel`, `description`, `contextPath`,
`placeholder`, `value`, `options` (native selects; capped at
`maxOptionsPerControl`, default 30 — a capped list sets `optionsTruncated: true`
and `optionCount`, the control's `text` stays in lockstep with the shown
options, and `select_option` verifies a value beyond the cap against the live
control), `hasValue`, `checked`,
`required`, `expanded`, `selected`, `pressed`, `current`, `invalid`, `disabled`,
`focused`, `offscreen`.

---

## 7. Actions

The planner returns one turn: `{ reason, findings?, actions: [ … ] }` — the
first action, then optional batched follow-ons. `findings` is an optional
turn-level annotation (it is not an action): each entry records a defect
(`severity` ∈ info|minor|major|critical; `category` ∈
accessibility|usability|functional|performance|security; `summary`;
`evidence?`) and can accompany any action, so reporting never costs a turn and
never conflicts with batching. Findings collect in `report.findings`.

| Action | Fields | Notes |
| --- | --- | --- |
| `click` | `target` | |
| `fill` | `target`, `value` | value may be `{{context:…}}` / `{{secret:…}}` / `{{input:…}}` |
| `select_option` | `target`, `value` | native `<select>` only (use `click` on a custom option); `value` may be an option value or its exact visible label |
| `hover` | `target` | reveal hover menus |
| `press_key` | `key` | `Tab`, `Shift+Tab`, `Enter`, `Escape`, `ArrowDown`, … — acts on the focused element |
| `scroll` | `containerId`, `direction` | scroll an observed scroll container |
| `navigate` | `url` | **same-origin only** |
| `go_back` | — | browser back |
| `wait_until_gone` | `expectGone.documentText` | wait for text to disappear during a transition |
| `request_user_input` | `inputKey`, `inputPrompt` | headed only; value reused via `{{input:key}}` |
| `request_user_interaction` | `interactionPrompt` | headed only; ask the human to act |
| `request_screenshot` | `screenshotPrompt` | delivers a set-of-marks-annotated viewport image next turn |
| `finish` / `give_up` | — | terminate the run |

`target` selector: any subset of control fields (`id`, `tag`, `role`, `type`,
`text`, `label`, `ariaLabel`, `placeholder`, `priority`, `hasValue`, `checked`,
`disabled`). Must match exactly one visible control. The lightweight `{ id:
"a3" }` is preferred by default (strict models require id-only).

### Batching

- Only `click`, `fill`, `select_option`, `hover`, `press_key` may follow the
  first action; anything that navigates/waits/terminates/escalates must stand
  alone. (Findings are a turn-level field, not an action, so they batch freely.)
- Follow-ons execute against the same observation the batch was planned from,
  pinned to the exact element (per-turn stamp). If a later element changed or
  was removed, the action aborts the rest of the batch and the next turn
  re-plans. So independent bulk work (whole form, many rows) runs in one turn,
  while any real UI change stops the batch.
- No fixed ceiling on batch size. `maxActionsPerTurn` optionally caps it:
  `0` (default) = unlimited, `1` = disable batching, `N ≥ 2` = cap at N.
  Also `DUBLO_MAX_ACTIONS_PER_TURN` / `config set max-actions-per-turn`.
- Practical limits: the observation's visible-control cap and the model's output
  budget, so hundreds of rows still chunk by viewport.

---

## 8. Reports & signals

- `<output-dir>/<run-id>/report.json` — the full record; plus `summary.md` and
  `summary.html`, and per-step screenshots (when `screenshots` ≠ `none`) / HTML
  (when `--debug`). `<output-dir>/latest.json` points at the most recent run.
- `report.json` top level: `runId`, `objective`, `config`, `startedAt`/
  `finishedAt`, `status` (passed|failed|interrupted), `finalUrl`,
  `findings[]`, `steps[]`, `pricing`, `costEstimate`, `artifactsDir`, and
  `tokenUsage`.
- `tokenUsage`: `inputTokens`, `outputTokens`, `totalTokens`,
  `cacheReadInputTokens`, `cacheWriteInputTokens`, `plannerCalls`,
  `escalationCalls`, `selfHealCalls`, `formatRetries`.
- Each step: index, name, `plannerAction`, `outcome` (ok|error), `error?`,
  `phase` (`init`|`batch`), `runtimeErrors?`, duration, url, and (in `--debug`)
  the redacted observation.
- **`runtimeErrors`** (per observation/step): deterministic, zero-token signals
  captured since the previous step — console errors, uncaught exceptions, failed
  / `≥400` HTTP responses, failed requests, and native dialogs (auto-dismissed
  so an unexpected `alert()`/`confirm()` can't hang the run). Shown to the
  planner as objective evidence; secrets in the text are scrubbed.
- **`costEstimate`**: input/output/cacheRead/cacheWrite/total in the profile's
  currency, when pricing is configured.

---

## 9. Environment variables

Precedence-relevant (`DUBLO_*` overrides `defaults.json`, is overridden by CLI):

`DUBLO_WORKSPACE`, `DUBLO_BASE_URL`, `DUBLO_LLM`, `DUBLO_ESCALATION_LLM`,
`DUBLO_PERSONA`, `DUBLO_CONTEXT`, `DUBLO_SCENARIO`, `DUBLO_SCENARIO_FILE`,
`DUBLO_ADHOC_SCENARIO`, `DUBLO_MAX_STEPS`, `DUBLO_MAX_ACTIONS_PER_TURN`,
`DUBLO_SETTLE_DELAY_MS`, `DUBLO_SETTLE_TIMEOUT_MS`, `DUBLO_HEADLESS`,
`DUBLO_SCREENSHOTS`, `DUBLO_REPORTS`, `DUBLO_DEBUG`, `DUBLO_OUTPUT_DIR`,
`DUBLO_OBSERVATION_CONFIG_FILE`.

LLM overrides: `DUBLO_LLM_PROVIDER`, `DUBLO_LLM_REGION`, `DUBLO_LLM_MODEL_ID`,
`DUBLO_LLM_BASE_URL`, `DUBLO_LLM_API_KEY`, `DUBLO_LLM_INPUT_PRICE`,
`DUBLO_LLM_OUTPUT_PRICE`, `DUBLO_LLM_CACHE_READ_PRICE`,
`DUBLO_LLM_CACHE_WRITE_PRICE`, `DUBLO_LLM_CURRENCY`, `DUBLO_LLM_TOKEN_UNIT`.

Secrets: `DUBLO_SECRET_<path>` (use `__` for dotted paths).

---

## 10. Operational notes

- **Headed vs headless**: default headed. `request_user_input` /
  `request_user_interaction` only work headed (they prompt a human). Use
  `--headless` for CI, but then the agent can't escalate to a human.
- **Interruptions**: Ctrl-C or closing the browser ends the run as
  `interrupted`; a report is still written.
- **Same-origin navigation**: `navigate` is blocked cross-origin; the agent is
  told not to use "Continue with Google" (that page won't load in-browser).
- **Scenario prompt file**: `<workspace>/prompt.md`, if present, is injected as
  app-specific background into every run — put quirks, test accounts, and
  house rules there.
