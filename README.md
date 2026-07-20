# dublo

Agentic LLM-in-the-loop web testing CLI using Playwright and AWS Bedrock.

The TypeScript migration, library API, CLI redesign, and quality roadmap are documented in [the implementation plan](docs/implementation-plan.md).

## Requirements

- Node.js 20+
- AWS credentials configured (profile, env vars, or IAM role)
- Bedrock model access in your AWS account

## Install

```bash
npm install
```

Install Playwright browser binaries (one-time per machine):

```bash
npx playwright install chromium
```

If your system is missing native browser dependencies, install them with:

```bash
npx playwright install-deps chromium
```

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
dublo report list [options]
dublo report show [run-id] [options]
dublo report open [run-id] [options]
dublo report render [run-id] [options]

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

`dublo config show` displays persisted defaults. `dublo config show --effective` displays the non-secret effective configuration and the source of each value. `config set` accepts `base-url`, `llm`, `persona`, `max-steps`, `settle-delay-ms`, `settle-timeout-ms`, `headless`, `screenshots`, `debug`, `output-dir`, and `observation-config`. The settle settings control the runner's UI stability debounce before LLM observations; defaults are `500ms` stable time and a `3000ms` maximum polling window.

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
  "tokenUnit": 1000000
}
```

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

- Add robust model output schema validation
- Add richer action types (navigate, press, screenshot, evaluate)
- Add junit/json result reporting
- Add retries and safety guards for flaky selectors
- Add test fixtures and integration tests
