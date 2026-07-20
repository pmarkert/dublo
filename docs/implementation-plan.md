# Dublo Implementation Plan

## Purpose

Transform Dublo from a JavaScript CLI with a monolithic runtime into a TypeScript package with:

- A polished, automation-friendly CLI.
- A stable, documented library API for test harnesses and custom integrations.
- Strict compile-time types and runtime validation at every untrusted boundary.
- A testable core that does not depend on Node process globals, Playwright, AWS, or terminal I/O.

This is a new application. The work should target the desired end state directly. Do not add compatibility shims, deprecated aliases, or transitional command syntax.

## Target Decisions

### Language and Tooling

- Convert the codebase directly to TypeScript using native ESM.
- Use `tsc` in strict mode for type checking and declaration generation.
- Use `node:test` for unit and integration tests to avoid adding a test framework unless a later need justifies one.
- Use ESLint with TypeScript support and Prettier for static style enforcement.
- Use Zod for validation of JSON files, YAML files, environment variables, CLI-normalized inputs, LLM tool outputs, and persisted reports.
- Use `tsx` for local TypeScript execution during development.

### Package Contract

Publish an ESM-only package with explicit export paths:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node/index.d.ts",
      "import": "./dist/node/index.js"
    },
    "./package.json": "./package.json"
  },
  "bin": {
    "dublo": "./dist/cli.js"
  }
}
```

The root entry point must contain platform-neutral interfaces, schemas, types, and orchestration APIs. The `./node` entry point may expose Node filesystem workspace helpers and default Node adapters. Do not expose `commands`, `utils`, or internal implementation paths as public API.

### Configuration Precedence

Use one predictable precedence order for every non-secret setting:

```text
CLI option > DUBLO_* environment variable > workspace defaults.json > built-in default
```

Environment loading is a CLI concern. Library calls receive an explicit environment record and never call `dotenv.config()` implicitly.

Secrets must not be stored in workspace files or printed in resolved configuration:

- `DUBLO_LLM_API_KEY`
- AWS credentials and standard AWS credential-provider variables
- Provider-specific authentication variables added later

### CLI Contract

Use these command groups and remove the old ambiguous forms:

```text
dublo init [--workspace <path>] [--yes] [--base-url <url>] [--llm <name>]

dublo config show [--workspace <path>] [--effective] [--format <text|json>]
dublo config edit [--workspace <path>]
dublo config set <setting> <value> [--workspace <path>]
dublo config unset <setting> [--workspace <path>]
dublo config validate [--workspace <path>] [--format <text|json>]
dublo config context add <profile> [--workspace <path>]
dublo config context remove <profile> [--workspace <path>]
dublo config context clear [--workspace <path>]
dublo config report add <renderer> [--workspace <path>]
dublo config report remove <renderer> [--workspace <path>]
dublo config report clear [--workspace <path>]
dublo config prompt edit [--workspace <path>]
dublo config prompt show [--workspace <path>]

dublo run [scenario] [options]
dublo run --prompt <text> [options]

dublo llm create <name> [options]
dublo llm edit <name> [options]
dublo llm list [options]
dublo llm show <name> [options]
dublo llm validate [name] [options]

dublo persona list [options]
dublo persona show <name> [options]
dublo persona edit <name> [options]

dublo scenario list [options]
dublo scenario show <name> [options]
dublo scenario edit <name> [options]

dublo context list [options]
dublo context show <name> [options]
dublo context edit <name> [options]
dublo context validate [name] [options]

dublo report list [options]
dublo report show [run-id] [options]
dublo report open [run-id] [options]
dublo report render [run-id] [options]
dublo completion <shell>
```

Rules:

- `init` creates a workspace and its standard directories. It may seed initial scalar defaults through flags, but it is not an alias for `config` and must not overwrite an existing `defaults.json` without an explicit `--force` option.
- `config show` displays the persisted workspace `defaults.json`, normalized for presentation and without environment overrides. `config show --effective` displays the non-secret configuration after applying environment and built-in defaults, with each value's source. `--format json` writes the selected validated document; `config validate` validates the persisted document and referenced profiles without running a scenario.
- `config edit` is an explicit whole-document operation: it opens a temporary copy of `defaults.json` using `VISUAL`, `EDITOR`, then the platform editor fallback; when stdin is not a TTY, it validates stdin as the replacement document. Both paths validate before atomically replacing `defaults.json` and leave the existing file unchanged on validation failure.
- `config set <setting> <value>` is the ergonomic non-interactive path for one scalar setting. It accepts only the documented settings `base-url`, `llm`, `persona`, `max-steps`, `headless`, `screenshots`, `debug`, `output-dir`, and `observation-config`. Values are parsed and validated according to the setting schema, profile references are resolved before writing, and the command prints the changed key and resulting value.
- `config unset <setting>` removes a persisted scalar setting so runtime resolution can fall through to environment or built-in defaults. It is not permitted for list settings.
- `context` and `reports` are ordered collections, so modify them through explicit `config context add|remove|clear` and `config report add|remove|clear` commands. Do not overload `config set` with comma-delimited strings, ad hoc JSON, or a generic dotted-path syntax.
- `config` commands modify only `defaults.json`; prompt content is deliberately managed through `config prompt`, while LLM, persona, scenario, and context documents remain managed by their own command groups.
- The `run` positional argument is always a scenario profile or path, never inline scenario text.
- `--prompt` is the only inline scenario option. Piped stdin is allowed only when neither a scenario nor `--prompt` is provided.
- `report` is the sole namespace for persisted run results. Do not add a `runs` command or a `run list` subcommand.
- `report list` displays recent reports in reverse chronological order with run ID, status, completion time, objective, and final URL. It accepts `--limit <count>`, `--status <passed|failed|interrupted>`, and `--format <text|json>`.
- `report show [run-id]` writes a console summary for the selected report. Without a run ID, it resolves `reports/latest.json` and shows the most recent report. `--format json` writes the validated raw report document; `--steps` includes per-step detail in text output.
- `report open [run-id]` opens the selected report in the system viewer and defaults to the most recent report. It opens the HTML summary by default; `--markdown` selects the Markdown summary and `--json` selects `report.json`.
- `report render [run-id]` regenerates selected report artifacts and defaults to the most recent report. It accepts repeatable `--report <id>` values, defaults to all configured built-in renderers, and uses `--open` only to open the artifacts it generated.
- All report commands accept either a run ID under the configured report output directory or an explicit `report.json` path. The help text calls this optional argument `[run-id]` and documents the path behavior in the command description.
- Commands that address one profile use a required positional `<name>`. Commands that may act on all profiles use optional `[name]`.
- Do not implement duplicate `--name` options when a positional name exists.
- All commands that access a workspace accept `--workspace <path>`.
- Run options must include `--base-url`, `--max-steps`, `--output-dir`, `--screenshots`, `--observation-config`, `--report <id>` (repeatable), `--no-report`, `--headless`/`--no-headless`, `--debug`/`--no-debug`, `--format <text|json>`, and `--quiet`.
- Repeated `--context`, `--set`, and `--json` options preserve their source-order merge semantics.
- Human-readable output goes to stdout/stderr according to command intent; `--format json` emits one machine-readable result document on stdout with logs on stderr.
- Exit codes are: `0` successful command or passed run, `1` operational or failed-run error, `2` invalid input or configuration, and `130` interrupted run.

The default report output directory is `./reports`, resolved relative to the workspace. Each run remains in a directory named `${runDateTime}_${pass|fail|abort}_${scenarioName|adhoc}`: `runDateTime` is a filesystem-safe UTC start timestamp, `scenarioName` is the scenario profile filename without its extension, and inline or stdin objectives use `adhoc`. `latest.json` remains at the output-directory root.

## Target Architecture

```text
src/
  index.ts                       Public platform-neutral API
  cli.ts                         Executable entry point only
  cli/
    create-program.ts            Commander registration and help
    commands/                    Command adapters; no domain logic
    output.ts                    Text/JSON renderers and exit-code mapping
    completion.ts                Completion registration
  core/
    config/
      schemas.ts                 Zod schemas and inferred types
      resolve.ts                 Pure precedence and normalization logic
    run/
      types.ts                   Run input, state, events, and result types
      runner.ts                  Orchestrates the run state machine
      planner.ts                 Prompt creation and planner-action parsing
      actions.ts                 Action validation and dispatch policy
      reports.ts                 Report creation and finalization
    profiles/
      types.ts                   Profile domain types
      resolver.ts                Pure profile-selection rules
    errors.ts                    Typed error hierarchy and error codes
  ports/
    browser.ts                   Browser/page abstraction
    planner.ts                   LLM planner abstraction
    artifacts.ts                 Report/artifact persistence abstraction
    interaction.ts               Human input/interaction abstraction
    logger.ts                    Structured logger abstraction
  node/
    index.ts                     Public Node adapter export path
    workspace-store.ts           Filesystem profile/workspace implementation
    artifact-store.ts            Filesystem artifact implementation
    playwright-browser.ts        Playwright browser implementation
    bedrock-planner.ts           Bedrock planner implementation
    openai-planner.ts            OpenAI-compatible planner implementation
    env.ts                       Explicit Node environment and dotenv loader
    reports/                     Built-in report renderers
  testing/
    fakes.ts                     Publicly reusable test doubles where useful
```

The `core` and `ports` folders must not import `node:fs`, `node:process`, `readline`, `child_process`, Playwright, or AWS SDK modules. Imports of those packages are allowed only in `src/node` and `src/cli`.

## Library API

### Public Types and Functions

The root package export should expose the following contract:

```ts
export type {
  Browser,
  BrowserPage,
  Planner,
  ArtifactStore,
  InteractionProvider,
  RunEvent,
  RunInput,
  RunResult,
  ResolvedRunConfig,
  PlannerAction,
  Report,
};

export {
  runScenario,
  resolveRunConfig,
  createRunner,
  RunInputSchema,
  LlmProfileSchema,
  WorkspaceDefaultsSchema,
  PlannerActionSchema,
  ReportSchema,
};
```

`runScenario(input)` accepts an already resolved input plus dependencies and returns a `Promise<RunResult>`. It does not write to a terminal, set an exit code, or require a workspace directory.

`createRunner(dependencies)` returns a reusable runner for integrations that execute multiple scenarios. Dependencies are explicit and include a browser factory, planner, artifact store, optional interaction provider, logger, clock, and identifier generator.

`resolveRunConfig(input)` is deterministic and receives explicit workspace data and environment data. It returns either a fully resolved configuration or a typed configuration error.

### Events

Expose run progress through an event callback and an async event stream. Event payloads must be discriminated unions and must never include secrets.

```ts
type RunEvent =
  | { type: "run.started"; runId: string; startedAt: string }
  | { type: "planner.requested"; step: number; observation: Observation }
  | { type: "planner.responded"; step: number; action: PlannerAction }
  | { type: "step.completed"; step: RunStep }
  | { type: "run.finished"; result: RunResult };
```

The CLI subscribes to events to render progress. Library consumers can stream events into their own reporters, telemetry, or test framework assertions.

### Node Adapters

The `dublo/node` export provides opt-in defaults:

```ts
export {
  createNodeRunner,
  createWorkspaceStore,
  createFileArtifactStore,
  createPlaywrightBrowserFactory,
  createBedrockPlanner,
  createOpenAICompatiblePlanner,
  loadDotenv,
};
```

This keeps Playwright and AWS concrete implementations out of the root API and makes provider/browser substitution straightforward.

## Delivery Plan

### Phase 0: Establish the Contract

1. Add this plan to the repository and link it from the README.
2. Add `CONTRIBUTING.md` with Node version, install, build, test, lint, format, and release commands.
3. Define the new CLI command table in README examples before implementation begins.
4. Define the public API in `src/index.ts` as type-only stubs and document it with TSDoc.
5. Add an API contract test that imports only `dublo` and `dublo/node`; prohibit deep-import examples from documentation.

Validation gate:

- The README, plan, and exported type stubs agree on command names, option names, and public import paths.

### Phase 1: TypeScript and Quality Toolchain

1. Replace JavaScript and `.mjs` source files with `.ts` files in the new target directory structure. Do not retain parallel JavaScript sources.
2. Add `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true`, declaration output, source maps, and `outDir: dist`.
3. Add `eslint.config.js` using TypeScript-aware linting and a Prettier configuration.
4. Add package scripts: `build`, `typecheck`, `test`, `test:watch`, `lint`, `format`, `format:check`, `check`, `dev`, and `prepack`.
5. Configure `files` so published artifacts contain `dist`, `resources`, README, and license files only. Do not publish TypeScript source by default.
6. Update the bin target to `dist/cli.js` and test the packed tarball with `npm pack --dry-run`.

Validation gate:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

### Phase 2: Schemas, Errors, and Configuration

1. Add Zod schemas for workspace defaults, LLM profiles, context documents, observation configuration, run input, report data, and planner actions.
2. Infer all public data types from schemas; do not create separate manually maintained interfaces for the same serialized data.
3. Introduce typed errors with stable codes, including `INVALID_INPUT`, `INVALID_CONFIG`, `PROFILE_NOT_FOUND`, `PLANNER_ERROR`, `BROWSER_ERROR`, `ARTIFACT_ERROR`, and `INTERRUPTED`.
4. Refactor configuration resolution into pure functions that accept CLI overrides, environment, workspace defaults, and built-in defaults explicitly.
5. Make profile resolution operate against an abstract profile/workspace store rather than filesystem calls.
6. Add redaction helpers and ensure API keys cannot enter logs, report JSON, rendered reports, or JSON command output.
7. Add table-driven unit tests for every precedence branch, boolean parsing branch, report selection, profile inference, `config set` field codec, collection update, and invalid serialized document.

Validation gate:

- Every accepted configuration document is schema-validated.
- Every precedence test proves `CLI > env > workspace > built-in`.
- Invalid configuration produces a typed error with exit code `2` in the CLI.

### Phase 3: Extract the Core Runner

1. Define ports for browser operations, planner requests, artifacts, interaction, logging, time, and run ID generation.
2. Move prompt construction, action schema validation, action-history policy, token accounting, pricing calculation, and report state transitions into `src/core/run`.
3. Implement `createRunner` and `runScenario` against ports only.
4. Replace direct calls to `process.stdout`, `process.stderr`, `process.stdin`, `process.exitCode`, `chromium.launch`, AWS SDK clients, filesystem writes, and report generation with injected dependencies.
5. Model interruption with `AbortSignal` rather than a mutable callback. All long-running port calls must receive and honor the signal where possible.
6. Return a complete `RunResult` for passed, failed, and interrupted outcomes. Do not use process side effects to communicate result state.
7. Add deterministic core tests using fake browser, planner, artifact, interaction, clock, and ID ports. Cover happy path, max steps, malformed planner result, disabled target recovery, user-input request, interrupt, artifact failure, and report finalization.

Validation gate:

- Core runner tests execute without Playwright, AWS credentials, filesystem writes, or terminal input.
- A test verifies importing `dublo` has no Node process, dotenv, Playwright, or AWS initialization side effects.

### Phase 4: Build Node Adapters

1. Implement `WorkspaceStore` for filesystem workspace defaults and profiles.
2. Deduplicate current LLM, persona, scenario, and context profile lookup rules into a single typed profile repository with resource-specific codecs.
3. Implement a Playwright browser adapter that contains all locator, observation, screenshot, wait, and page operations.
4. Implement separate Bedrock and OpenAI-compatible planner adapters behind the same planner port.
5. Implement a file artifact store that persists report JSON, screenshots, debug HTML, `latest.json`, and generated reports under the default `./reports` directory.
6. Adapt report generators to consume the typed report contract. Make the registry injectable so library consumers can register renderers without modifying package internals.
7. Implement terminal interaction and structured console logging as Node adapters, not core behavior.
8. Add adapter tests with mocked fetch/AWS client calls, a temporary directory, and Playwright-free browser fakes. Add a small Playwright integration fixture for the adapter boundary only.

Validation gate:

- `createNodeRunner` can execute a fixture scenario using fakes for the planner.
- Report renderer registration is covered by an integration test.
- Filesystem failures and provider failures are reported as typed errors without leaking secrets.

### Phase 5: Rebuild the CLI as an Adapter

1. Implement `createProgram()` in `src/cli/create-program.ts` so CLI construction can be tested without calling `process.exit`.
2. Register only the target command grammar described in this plan.
3. Centralize shared workspace options and help examples. Implement `init` as workspace creation and the `config` namespace as show, edit, set, unset, validate, collection, and prompt operations. Each command should have a concise description, one common example, and accurate option defaults.
4. Parse CLI input into typed command inputs, resolve configuration through the application service, create Node dependencies, and render events/results.
5. Use Commander option conflicts and implications where applicable: `--prompt` conflicts with a positional scenario; `--no-report` conflicts with `--report`; interactive options require headed mode.
6. Provide text and JSON output renderers. Ensure JSON mode prints exactly one result document to stdout.
7. Generate completion for command names, profile positional arguments, workspace paths, report IDs, and option values. Completion must use the same typed profile repository as normal command execution.
8. Map typed errors and run outcomes to the documented exit codes in one location.
9. Add process-level integration tests that execute `node dist/cli.js` in temporary workspaces. Test help, invalid arguments, completion output, JSON mode, configuration precedence, `init`, `config show/edit/set/unset/validate`, collection operations, profile selection, stdin scenario input, report list/show/open/render behavior, latest-report fallback, and exit codes.

Validation gate:

```bash
node dist/cli.js --help
node dist/cli.js run --help
node dist/cli.js completion zsh
node --test test/cli/**/*.test.ts
```

### Phase 6: Documentation, Examples, and Release Readiness

1. Rewrite README around installation, `dublo init`, a minimal profile, a minimal run, CI usage, completions, and library embedding.
2. Add a `docs/library-usage.md` example using `createNodeRunner` and a fully custom fake planner/browser example using `createRunner`.
3. Add `docs/configuration.md` with schemas, precedence, profile lookup, secrets policy, and environment variables.
4. Add `docs/cli.md` generated or verified from `createProgram().helpInformation()` to prevent help drift.
5. Add GitHub Actions CI for Node 20 and the current active Node LTS: install, format check, lint, typecheck, unit tests, CLI integration tests, build, and package dry run.
6. Add a release checklist: clean tree, full check, package content inspection, package smoke test in a temporary consumer project, and public API compatibility review.

Validation gate:

- A temporary consumer can install the packed tarball, execute `dublo --help`, and import both documented package entry points.
- Every code snippet in README and `docs/` is exercised by a documentation smoke test or a checked example project.

## Test Strategy

Use test layers with clear responsibility:

| Layer | Scope | Dependencies |
| --- | --- | --- |
| Unit | Schemas, precedence, parsing, state transitions, prompt construction, report rendering | None or fakes |
| Core integration | Runner behavior across ports | In-memory fakes |
| Node adapter | Workspace filesystem, provider protocols, artifacts | Temp dirs and mocked network clients |
| CLI integration | Command grammar, help, completion, JSON/text output, exit codes | Spawned Node process and temp workspace |
| Browser smoke | Real Playwright browser adapter behavior | Local fixture app only |
| Package smoke | Published exports and bin behavior | Packed tarball in a temp consumer |

Do not require AWS credentials, external LLMs, or public websites in unit, core, CLI, or CI tests. Provider integration tests must be explicitly opt-in and isolated from the default `npm test` command.

## Implementation Sequence

Use small pull requests in this order:

1. Tooling, TypeScript project configuration, and test harness.
2. Schemas, typed errors, configuration resolver, and tests.
3. Public API types and core ports.
4. Core runner extraction with fake-driven tests.
5. Node workspace, browser, planner, artifact, and report adapters.
6. CLI rewrite, completions, and process integration tests.
7. Documentation, CI, package exports, and packed-consumer smoke test.

Each pull request must keep `npm run check` green and avoid opportunistic refactors outside its assigned layer.

## Completion Criteria

The migration is complete when all of the following are true:

- Source code is TypeScript and passes strict type checking.
- The CLI is compiled from `src/cli.ts` and exposes only the target command grammar.
- Root and `dublo/node` import paths are documented, declaration-backed, and package-smoke-tested.
- The core runner can execute entirely against fakes without Node, Playwright, AWS, or terminal side effects.
- Node adapters provide the default CLI runtime behavior.
- All serialized external inputs and persisted report outputs are runtime-validated.
- Configuration precedence, profile resolution, run outcomes, and CLI exit codes are covered by automated tests.
- Shell completion covers the target command grammar and dynamic workspace profiles.
- Standard checks, package inspection, and documentation smoke tests run in CI.