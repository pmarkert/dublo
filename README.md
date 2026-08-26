# dublo

Agentic LLM-in-the-loop web testing CLI using Playwright and AWS Bedrock.

The TypeScript migration, library API, CLI redesign, and quality roadmap are documented in [the implementation plan](docs/implementation-plan.md).

## Requirements

- Node.js 20+
- AWS credentials configured (profile, env vars, or IAM role)
- Bedrock model access in your AWS account

## Install

From a source checkout (for developing Dublo):

```bash
npm install && npm run build
```

To use the `dublo` CLI in another project, install it globally (it builds on
install via the `prepare` script):

```bash
npm install -g dublo                     # once published to npm
npm install -g github:pmarkert/dublo     # or straight from GitHub
```

Install Playwright browser binaries (one-time per machine):

```bash
npx playwright install chromium
```

If your system is missing native browser dependencies, install them with:

```bash
npx playwright install-deps chromium
```

### Testing an app in another repository

Dublo is a standalone test runner that drives your app over HTTP; the app's repo
does not depend on it. To test another project:

```bash
cd /path/to/your-app
dublo init --workspace ./.dublo --base-url http://localhost:3000   # commit ./.dublo with the app
dublo llm config --workspace ./.dublo                              # configure the model
dublo skill install                                                # add the Dublo skill for Claude Code
# start your app, then:
dublo run --workspace ./.dublo --adhoc "Sign in and confirm the dashboard loads."
```

`dublo skill install` copies the bundled agent skill into `./.claude/skills/dublo`
(use `--user` for `~/.claude/skills`, `--force` to update after upgrading), so an
agent working in that repo becomes a Dublo expert. `dublo skill show` prints the
skill to stdout. Keep `./.dublo/` (scenarios, personas, context) in the app repo
so tests live with the app.

## Quick start

1. Create a workspace:

```bash
dublo init --workspace ./.dublo --base-url https://example.com
```

2. Install Chromium (one-time):

```bash
npx playwright install chromium
```

3. Create or select an LLM profile, then run a scenario:

```bash
dublo llm config default --workspace ./.dublo
dublo run homepage-smoke --workspace ./.dublo
```

If no scenario is specified, dublo reads scenario text from stdin:

```bash
echo "Verify the home page loads and primary CTA is visible." | dublo run --workspace ./.dublo
```

For local development, use the compiled CLI after building:

```bash
npm run build
node dist/cli.js run homepage-smoke --workspace ./.dublo
```

Workspace defaults can be inspected and updated without rerunning the full setup flow:

```bash
dublo config show --workspace ./.dublo
dublo config set max-steps 60 --workspace ./.dublo
dublo config context add qa-user --workspace ./.dublo
dublo config validate --workspace ./.dublo

# edit the workspace prompt markdown file
dublo config prompt edit --workspace ./.dublo

# print the workspace prompt markdown file
dublo config prompt show --workspace ./.dublo
```

Interactive LLM profile setup:

```bash
dublo llm config
```

The LLM wizard lets users:

- choose from a recommended Bedrock model list for the selected region, or
- enter any custom Bedrock model ID manually.

`dublo init` creates `<workspace>/defaults.json` and initializes:

- `<workspace>/llm`
- `<workspace>/personas`
- `<workspace>/scenarios`
- `<workspace>/context`
- `<workspace>/blocks`

Workspace prompt:

- `dublo config prompt edit` edits `<workspace>/prompt.md`
- `dublo config prompt show` writes `<workspace>/prompt.md` to stdout
- if `prompt.md` exists, its contents are injected into the LLM prompt as application-specific background and testing instructions

## Shell completion

Generate completion scripts with:

```bash
dublo completion <shell>
```

Examples:

```bash
# zsh (temporary in current shell)
eval "$(dublo completion zsh)"

# bash (temporary in current shell)
eval "$(dublo completion bash)"

# fish (temporary in current shell)
dublo completion fish | source
```

## CLI usage

````bash
dublo init [options]
dublo config show [options]
dublo config show --effective [options]
dublo config edit [options]
dublo config set <setting> <value> [options]
dublo config unset <setting> [options]
dublo config validate [options]
dublo config context add|remove|clear [options]
dublo config report add|remove|clear [options]
dublo config prompt edit|show [options]
dublo run [scenario] [options]
dublo run checkout --init login --init select-tenant
dublo llm config [profile] [options]
dublo llm list [options]
dublo llm show [profile] [options]
dublo llm validate [profile] [options]
dublo persona list [options]
dublo persona show <profile> [options]
dublo persona edit <profile> [options]
dublo scenario list [options]
dublo scenario show <profile> [options]
dublo scenario edit <profile> [options]
dublo context list [options]
dublo context show <profile> [options]
dublo context edit <profile> [options]
dublo context validate [profile] [options]
dublo block import <name> [run-id] [options]
dublo block list [options]
dublo block show <name> [options]
dublo block edit <name> [options]
dublo block validate [name] [options]
dublo report list [options]
dublo report show [run-id] [options]
dublo report open [run-id] [options]
dublo report render [run-id] [options]
dublo skill install [--target <dir>] [--user] [--force]
dublo skill show

Options:
  --workspace <path>    Workspace directory containing defaults.json and llm/personas/scenarios/context folders
  --llm <value>         LLM config file path or profile name in <workspace>/llm
  --persona <value>     Persona file path or profile name in <workspace>/personas
  --scenario <value>    Scenario file path or profile name in <workspace>/scenarios
  --headless            Run browser in headless mode (default is headed)
  --debug               Enable debug logging for this run
  --open                Open the generated HTML report when the run finishes
  --context <value>     Context file path or profile name in <workspace>/context (repeatable)
  --set <keyValue>      Inline context assignment key.path=value (or key.path:value); repeatable
  --json <object>       Inline JSON object merged into context (repeatable)
  --secret <pathEnv>    Environment-backed secret path=ENV_VAR for {{secret:path}} fills (repeatable)

`dublo init` creates a new workspace and refuses to overwrite existing defaults without `--force`.

`dublo config show` displays persisted defaults. `dublo config show --effective` displays the non-secret effective configuration and the source of each value. `config set` accepts `base-url`, `llm`, `escalation-llm`, `persona`, `max-steps`, `max-actions-per-turn`, `settle-delay-ms`, `settle-timeout-ms`, `headless`, `screenshots`, `debug`, `output-dir`, and `observation-config`. The settle settings control the runner's UI stability debounce before LLM observations; defaults are `500ms` stable time and a `20000ms` maximum polling window.

`dublo report list` shows saved reports. `dublo report show`, `open`, and `render` default to the report named by `latest.json` when no run ID is provided.

Legacy profile command details:

```text

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --region <region>     Bedrock region override
  --model-id <id>       Bedrock model ID override
  --inference-profile <scope>  Inference profile scope for models that support it (global or us)
  --service-tier <tier>  Service tier for models that support it (default, priority, flex, reserved)
  --set-default         Set workspace config llm field to this profile (non-interactive mode)
  -y, --yes             Accept defaults/flags and write profile without prompts

dublo llm list [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo llm show [profile] [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --name <profile>      LLM profile name override

dublo llm validate [profile] [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --name <profile>      LLM profile name override

dublo persona list [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

Built-in persona templates are bundled with Dublo and appear in `dublo persona list` alongside workspace personas.
You can use a built-in template name directly with `--persona`, export it with `dublo persona show <template>`, or seed a workspace copy with `dublo persona edit <template>`.

dublo persona show <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo persona edit <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo scenario list [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

Built-in scenario templates are bundled with Dublo and appear in `dublo scenario list` alongside workspace scenarios.
You can use a built-in template name directly with `--scenario`, export it with `dublo scenario show <template>`, or seed a workspace copy with `dublo scenario edit <template>`.

dublo scenario show <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo scenario edit <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo context list [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo context show <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)

dublo context edit <profile> [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --yaml                Force YAML file output (.yaml/.yml) for new or matching existing profile
  --json                Force JSON file output (.json) for new or matching existing profile

dublo context validate [profile] [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --name <profile>      Context profile name override

Current built-in scenario templates:

- `homepage-smoke`
- `login-happy-path`
- `checkout-happy-path`

Current built-in persona templates:

- `qa-strict`
- `exploratory`
- `accessibility`
- `performance`
````

Workspace runtime config (`<workspace>/defaults.json`) structure:

```json
{
  "baseUrl": "https://example.com",
  "llm": "default",
  "escalationLlm": "strong",
  "persona": "qa-strict",
  "context": ["shared", "qa-user"],
  "maxSteps": 40,
  "headless": false,
  "screenshots": "none",
  "debug": false,
  "outputDir": "./reports"
}
```

LLM profile (`<workspace>/llm/<name>.json`) structure:

```json
{
  "provider": "bedrock",
  "region": "us-east-1",
  "modelId": "amazon.nova-pro-v1:0",
  "inferenceConfig": {
    "temperature": 0
  },
  "additionalModelRequestFields": {},
  "inputPrice": 0.8,
  "outputPrice": 3.2,
  "cacheReadPrice": 0.2,
  "cacheWritePrice": 0,
  "currency": "USD",
  "tokenUnit": 1000000,
  "promptCaching": true
}
```

### Two-tier model routing (escalation)

Set an optional `escalationLlm` — a second LLM profile name — to run most steps
on a cheap model and switch to a stronger one only when needed:

```bash
dublo config set escalation-llm strong --workspace ./.dublo
# or per run:
dublo run checkout --llm cheap --escalation-llm strong --workspace ./.dublo
```

The escalation model is used for a turn when the primary model hits a recoverable
failure or the observation was truncated, and it rescues a `give_up` by retrying
the turn once with the stronger model. Resolution order mirrors `--llm`:
`--escalation-llm` > `DUBLO_ESCALATION_LLM` > workspace `escalationLlm`. Escalation
calls are counted in the report's `tokenUsage.escalationCalls`; cost is estimated
at the primary model's rates.

When the planner calls `request_screenshot`, the captured image is annotated with
**set-of-marks** labels — the same control ids (`a1`, `a2`, …) drawn on each
observed control — so vision models can target controls by id even when the DOM
is hostile. This is on by default.

`promptCaching` (Bedrock only, default `false`) inserts cache points after the
system prompt and the static planner context so the large, run-stable prefix
(system prompt, persona, scenario, planning rules, context data) is read from
cache on every step instead of being re-billed at the full input rate. Enable
it on models that support Bedrock prompt caching (e.g. Amazon Nova, Anthropic
Claude); it is the single biggest cost lever for long runs and pairs with the
`cacheReadPrice`/`cacheWritePrice` fields for accurate cost estimates. Prefixes
below a model's minimum cache size are ignored by Bedrock, so enabling it is
safe when the prompt is short.

For local or self-hosted LLMs using the OpenAI-compatible API (Ollama, LM Studio, llama.cpp, vLLM, etc.):

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "modelId": "llama3.2-vision"
}
```

An optional `apiKey` field can be set if the server requires authentication. For vision support (screenshots), use a multimodal model such as `llama3.2-vision`, `gemma3`, or `minicpm-v`. Prompt caching is skipped automatically for non-Bedrock providers.

If `inputPrice` and `outputPrice` are not present in the LLM config, cost estimation is skipped.

Profile name resolution behavior for `--llm`, `--persona`, `--scenario`, and `--context`:

- If the value points to an existing file path, that file is used.
- Otherwise, dublo looks for a matching profile name under `<workspace>/<type>`.
- `--context` can be repeated, and resolved context objects are merged in order from first to last.
- If no scenario is resolved or configured, dublo reads it from stdin.

LLM selector fallback order:

- `--llm`
- `DUBLO_LLM`
- `<workspace>/defaults.json` field `llm`
- If `<workspace>/llm` contains exactly one `.json` file, that file is used automatically.

Persona selector fallback order:

- `--persona`
- `DUBLO_PERSONA`
- `<workspace>/defaults.json` field `persona`
- If `<workspace>/personas` contains exactly one `.md` or `.txt` file, that file is used automatically.

Context sources are combined in this order, with later files overriding earlier top-level keys:

- `<workspace>/defaults.json` field `context` (string or array)
- `DUBLO_CONTEXT` (comma-separated)
- `--context` (repeatable)
- If none are set, no context file is loaded. An explicit `--context` adds to inherited context sources; it does not replace them.

Inline context updates:

- `--set` applies dotted-path assignments.
- `--json` applies top-level object merges.
- `--context`, `--set`, `--json`, and `--secret` are all repeatable.
- Mixed options are applied strictly in the order they are provided on the CLI.
- Value parsing for `--set`: `true`/`false` => booleans, `null` => null, numeric values => numbers, everything else => string.

Environment-backed secrets:

- `DUBLO_SECRET_password` automatically provides the `password` secret. Use `__` for dotted paths, such as `DUBLO_SECRET_checkout__token` for `checkout.token`.
- `--secret context.path=ENV_VAR` reads a non-empty value from `ENV_VAR`; `--secret context.path` requires `DUBLO_SECRET_context__path`. Explicit references override auto-discovered values for the same path.
- A referenced or auto-discovered secret that is missing or empty fails the run before browser automation starts. Secret values are never written to context files or planner messages.
- The planner receives the available secret paths, but not their values. It can fill a visible control with `{{secret:context.path}}`.
- Exact string matches in browser observations are replaced with `*******` before those observations are sent to the planner.
- Screenshots remain available to the planner and may reveal secret values rendered in the browser. Use `--screenshots none` when that disclosure risk is unacceptable.
- Secret references use `=` and accept dotted paths plus standard environment variable names (letters, numbers, and underscores).

Examples:

```bash
# simple scalar values
dublo run --set username:phillip --set retries=3

# nested values
dublo run --set auth.user.name=phillip --set auth.user.admin=true

# merge object JSON
dublo run --json '{"featureFlags":{"newCheckout":true}}'

# provide a password from the environment without exposing it to the planner
CHECKOUT_PASSWORD='correct-horse-battery-staple' dublo run --secret checkout.password=CHECKOUT_PASSWORD

# auto-discover a secret without adding a CLI option
DUBLO_SECRET_password='correct-horse-battery-staple' dublo run myday

# combine files + inline overrides
dublo run --context shared --context qa-user --set auth.user.name=phillip --json '{"region":"us-east-1"}'

# ordering is preserved across mixed types
dublo run --context base --set auth.user.name=phillip --json '{"auth":{"role":"admin"}}' --context final-overrides
```

Environment variable precedence:

- Only names: `DUBLO_*`
- CLI options override environment values, which override `<workspace>/defaults.json`, which override built-in defaults

Workspace env var:

- `DUBLO_WORKSPACE`

LLM-specific env vars:

- `DUBLO_LLM_PROVIDER`
- `DUBLO_LLM_REGION`
- `DUBLO_LLM_MODEL_ID`
- `DUBLO_LLM_BASE_URL` (required for `openai-compatible` provider)
- `DUBLO_LLM_API_KEY` (optional, for servers requiring auth)
- `DUBLO_LLM_INPUT_PRICE`
- `DUBLO_LLM_OUTPUT_PRICE`
- `DUBLO_LLM_CACHE_READ_PRICE`
- `DUBLO_LLM_CACHE_WRITE_PRICE`
- `DUBLO_LLM_CURRENCY`
- `DUBLO_LLM_TOKEN_UNIT`

The run command writes a manifest file at `output-dir/latest.json` for easy access to the most recent run artifacts.

## Agent actions

On each turn the planner returns one action, or a **short batch** of actions to run in sequence:

- `click`, `fill`, `select_option` — interact with an observed control.
- `hover` — reveal menus or content shown only on pointer hover.
- `press_key` — send a key (for example `Tab`, `Shift+Tab`, `Enter`, `Escape`, `ArrowDown`) to the focused element or page. `click` a control first to focus it. Each observation reports the currently focused control (`observation.focus` and a per-control `focused` flag), which is required for keyboard and accessibility testing.
- `scroll` — scroll an observed scroll container.
- `navigate` — go to a **same-origin** URL (cross-origin navigations are blocked); `go_back` — return to the previous page, useful for verifying that state survives browser back/forward.
- `wait_until_gone` — wait for specific visible text to disappear during a transition.
- `request_user_input`, `request_user_interaction`, `request_screenshot` — escalate to the human or ask for a screenshot (headed mode).
- `report_finding` — record a defect or notable issue **without ending the run** (see below).
- `finish`, `give_up` — terminate the run.

### Action batches

When several actions can be planned from the current screen and don't depend on each other's results — filling every field of a form from known values, toggling many rows before a bulk action — the planner may return them as a single batch instead of one action per model call.

The runner executes the batch in order, and every follow-on is **pinned to the exact element the planner saw** (via a per-turn stamp), so an id can never be remapped to a different control. If a later action's element has since changed or disappeared (a re-render, or a validation node that shifted the DOM), that action is a "target not found" that **aborts the rest of the batch**; the next turn re-observes and re-plans. So independent bulk work runs in one turn, while any real UI change stops the batch instead of acting blindly — and validation errors from a fully-filled form all surface together in the next observation. Only `click`, `fill`, `select_option`, `hover`, and `press_key` may follow the first action; anything that navigates, waits, finishes, gives up, reports a finding, or escalates must stand alone. Each executed action is still its own step in the report (batched follow-ons are tagged `phase: "batch"`).

Batching is **uncapped** — there is no fixed ceiling on actions per turn, so a turn may fill an entire form or toggle every visible row in one model call. The only natural limits are inherent: the observation lists up to `maxControls` controls (default 150), and the model's output-token budget bounds how many actions fit in one response, so very large lists (hundreds of rows) are still done in per-viewport chunks. Controls are **ranked by relevance** (in-viewport first, then keyword matches derived from the scenario) before the `maxControls` cap is applied, so truncation drops the least relevant controls rather than whatever is last in the DOM; set `maxControls` to `0` in an observation-config file to surface every control (at higher token cost), and the observation reports `truncated` when the cap bites. `maxActionsPerTurn` optionally imposes a cap: `0` (the default) means unlimited, `1` disables batching entirely (one action per turn), and any `N ≥ 2` caps the batch at N — useful only to rein in a model that over-batches. Configure it via `dublo config set max-actions-per-turn <n>`, the workspace default `maxActionsPerTurn`, or `DUBLO_MAX_ACTIONS_PER_TURN`. Batching is the main lever for cutting planner calls on form- and list-heavy flows, and compounds with prompt caching (which cuts the cost of each call).

## Regression replay with self-healing

`dublo block import <name>` builds a reusable initialization block from a passed
run, and `dublo run <scenario> --init <name>` replays it deterministically before
the planner takes over. Imported blocks record the **descriptive** target of each
step (label/text/role/type) rather than the ephemeral per-turn id, plus a URL
post-condition, so they resolve against later runs.

When a recorded step's target no longer resolves (the control moved, was renamed,
or is now ambiguous), the runner **self-heals**: it asks the planner to pick the
equivalent control in the current UI and executes that instead, preserving the
recorded fill value. Self-heal calls are counted in `tokenUsage.selfHealCalls`,
and a recorded URL post-condition fails the run loudly if a replayed step lands on
the wrong page. This turns brittle recorded flows into resilient regression checks
that cost planner tokens only on the steps that actually drifted.

## Findings and runtime signals

Two features turn a run into a defect report rather than a pass/fail:

- **Findings.** The planner can call `report_finding` with a `severity` (`info`, `minor`, `major`, `critical`), a `category` (`accessibility`, `usability`, `functional`, `performance`, `security`), a `summary`, and optional `evidence`. Findings are collected in `report.findings` and rendered in both the Markdown and HTML reports. This lets usability, accessibility, and security personas file specific issues as they go instead of burying them in action reasons.
- **Runtime signals.** Every observation includes `runtimeErrors`: console errors, uncaught exceptions, failed/`>= 400` HTTP responses, failed requests, and native dialogs captured since the previous step. Native dialogs are auto-dismissed so an unexpected `alert()`/`confirm()` cannot hang the run. These deterministic, zero-token signals are shown to the planner (as objective evidence, not instructions), recorded per step in the report, and any secret values embedded in them are masked.

## Project structure

```text
src/
  dublo.js
  scenario-runner.mjs
  commands/
    run.js
  config/
    loadScenarioConfig.js
  utils/
    logger.js
dublo.workspace.example.json
llm.default.example.json
```

## Next suggested enhancements

See [docs/agent-interaction-recommendations.md](docs/agent-interaction-recommendations.md) for the full review. Remaining higher-effort items:

- Non-ARIA name/role fallbacks and an accessibility-tree (`ariaSnapshot`) observation mode.
- Observation coverage for shadow DOM, iframes, and inferred non-semantic clickables.
- Regression replay with self-healing, and short high-confidence action batches.
- Set-of-marks screenshots and two-tier (cheap/escalation) model routing.
- Add junit/json result reporting and more integration fixtures.
