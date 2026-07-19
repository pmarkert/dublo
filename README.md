# dublo

Agentic LLM-in-the-loop web testing CLI using Playwright and AWS Bedrock.

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

1. Create a workspace and runtime config:

```bash
mkdir -p .dublo/llm .dublo/personas .dublo/scenarios .dublo/context
cp dublo.workspace.example.json .dublo/config.json
cp llm.default.example.json .dublo/llm/default.json
```

2. Install Chromium (one-time):

```bash
npx playwright install chromium
```

3. Run with profile selectors:

```bash
npm run run -- --workspace ./.dublo --llm default --scenario "Verify the home page loads and primary CTA is visible."
```

If no scenario is specified in config or via `--scenario`, dublo reads scenario text from stdin:

```bash
echo "Verify the home page loads and primary CTA is visible." | npm run run -- --workspace ./.dublo --llm default
```

Or call directly:

```bash
node src/dublo.js run --workspace ./.dublo --llm default
```

Interactive workspace setup:

```bash
dublo configure
# or
dublo config
```

Interactive LLM profile setup:

```bash
dublo llm configure
dublo llm config
```

The LLM wizard lets users:

- choose from a recommended Bedrock model list for the selected region, or
- enter any custom Bedrock model ID manually.

This guided flow creates/updates `<workspace>/config.json` and can initialize:

- `<workspace>/llm`
- `<workspace>/personas`
- `<workspace>/scenarios`
- `<workspace>/context`

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

```bash
dublo run [options]
dublo configure [options]
dublo llm configure [options]
dublo llm config [profile] [options]
dublo llm list [options]
dublo llm show [profile] [options]
dublo llm validate [profile] [options]

Options:
  --workspace <path>    Workspace directory containing config.json and llm/personas/scenarios/context folders
  --llm <value>         LLM config file path or profile name in <workspace>/llm
  --persona <value>     Persona file path or profile name in <workspace>/personas
  --scenario <value>    Scenario file path or profile name in <workspace>/scenarios
  --headless            Run browser in headless mode (default is headed)
  --context <value>     Context file path or profile name in <workspace>/context (repeatable)
  --set <keyValue>      Inline context assignment key.path=value (or key.path:value); repeatable
  --json <object>       Inline JSON object merged into context (repeatable)

dublo configure [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  -y, --yes             Accept defaults and write config without prompts

dublo llm configure [profile] [options]

Options:
  --workspace <path>    Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)
  --region <region>     Bedrock region override
  --model-id <id>       Bedrock model ID override
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
```

Workspace runtime config (`<workspace>/config.json`) structure:

```json
{
  "baseUrl": "https://example.com",
  "llm": "default",
  "persona": "qa-strict",
  "context": ["shared", "qa-user"],
  "maxSteps": 40,
  "headless": false,
  "artifactScreenshotMode": "none",
  "debug": false,
  "outputDir": "./output/runs"
}
```

LLM profile (`<workspace>/llm/<name>.json`) structure:

```json
{
  "provider": "bedrock",
  "region": "us-east-1",
  "modelId": "amazon.nova-pro-v1:0",
  "inputPrice": 0.8,
  "outputPrice": 3.2,
  "cacheReadPrice": 0.2,
  "cacheWritePrice": 0,
  "currency": "USD",
  "tokenUnit": 1000000
}
```

If `inputPrice` and `outputPrice` are not present in the LLM config, cost estimation is skipped.

Profile name resolution behavior for `--llm`, `--persona`, `--scenario`, and `--context`:

- If the value points to an existing file path, that file is used.
- Otherwise, dublo looks for a matching profile name under `<workspace>/<type>`.
- `--context` can be repeated, and resolved context objects are merged in order from first to last.
- If no scenario is resolved or configured, dublo reads it from stdin.

LLM selector fallback order:

- `--llm`
- `DUBLO_LLM`
- `<workspace>/config.json` field `llm`
- If `<workspace>/llm` contains exactly one `.json` file, that file is used automatically.

Persona selector fallback order:

- `--persona`
- `DUBLO_PERSONA`
- `<workspace>/config.json` field `persona`
- If `<workspace>/personas` contains exactly one `.md` or `.txt` file, that file is used automatically.

Context selector fallback order:

- `--context` (repeatable)
- `DUBLO_CONTEXT` (comma-separated)
- `<workspace>/config.json` field `context` (string or array)
- If none are set, no context file is loaded.

Inline context updates:

- `--set` applies dotted-path assignments.
- `--json` applies top-level object merges.
- `--context`, `--set`, and `--json` are all repeatable.
- Mixed options are applied strictly in the order they are provided on the CLI.
- Value parsing for `--set`: `true`/`false` => booleans, `null` => null, numeric values => numbers, everything else => string.

Examples:

```bash
# simple scalar values
dublo run --set username:phillip --set retries=3

# nested values
dublo run --set auth.user.name=phillip --set auth.user.admin=true

# merge object JSON
dublo run --json '{"featureFlags":{"newCheckout":true}}'

# combine files + inline overrides
dublo run --context shared --context qa-user --set auth.user.name=phillip --json '{"region":"us-east-1"}'

# ordering is preserved across mixed types
dublo run --context base --set auth.user.name=phillip --json '{"auth":{"role":"admin"}}' --context final-overrides
```

Environment variable fallback (optional):

- Only names: `DUBLO_*`
- `<workspace>/config.json` overrides env for runtime options
- `--llm/--persona/--scenario/--context` override env selectors

Workspace env var:

- `DUBLO_WORKSPACE`

LLM-specific env vars:

- `DUBLO_LLM_PROVIDER`
- `DUBLO_LLM_REGION`
- `DUBLO_LLM_MODEL_ID`
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
