---
name: dublo
description: >-
  Drive Dublo, the agentic LLM web-testing CLI (Playwright + AWS Bedrock or any
  OpenAI-compatible endpoint), to test web apps end to end. Use when the user
  wants to test or QA a web app with Dublo, set up a Dublo workspace, write or
  run a Dublo scenario or persona, replay a recorded flow, tune Dublo's
  observation / batching / cost settings, configure its LLM (Bedrock or
  OpenAI-compatible, prompt caching, escalation model), or read a Dublo run
  report. Covers every CLI command, config option, and environment variable.
---

# Dublo

Dublo runs an LLM-in-the-loop agent that drives a real Chromium browser to test
web apps. Each turn it **observes** the page (a compact, ranked JSON of visible
controls — no screenshots required), asks a planner LLM for the **next action or
a short batch of actions**, **executes** them against the live DOM (re-validating
each), waits for the UI to settle, and repeats until the scenario's success
criteria are met (`finish`) or it runs out of steps / gives up.

You are the operator. Your job is to configure the workspace, choose the model
and persona for the goal, write or select a scenario, run it, and read the
report — tuning observation, batching, and cost as needed.

## When to use this skill

- Testing or QA-ing a web app by describing a goal in natural language.
- Setting up or configuring a Dublo workspace, LLM profile, persona, or scenario.
- Recording a passing flow and replaying it as a regression check.
- Tuning cost (prompt caching, cheap/escalation model routing, batching,
  control budget) or observation behavior (shadow DOM, off-viewport, inferred
  clickables).
- Reading a run report (status, findings, runtime errors, token usage, cost).

**Full parameter reference:** read `references/reference.md` in this skill for
the exhaustive list of CLI commands, config fields, LLM profile fields, the
observation-config schema, the action set, report structure, and every
environment variable. This page is the mental model and the common recipes;
the reference is the source of truth for exact option names and defaults.

## Requirements

- Node.js 20+, and a one-time `npx playwright install chromium`.
- A planner LLM, either:
  - **Bedrock** — AWS credentials + Bedrock model access (default provider), or
  - **OpenAI-compatible** — a local/self-hosted server (Ollama, LM Studio,
    vLLM, llama.cpp) via `baseUrl`; use a vision model only if you need
    screenshots.

## Quickstart

```bash
# 1. Create a workspace (folders for llm/personas/scenarios/context/blocks)
dublo init --workspace ./.dublo --base-url https://example.com

# 2. Configure an LLM profile (interactive wizard, or edit .dublo/llm/<name>.json)
dublo llm config            # wizard: pick a Bedrock model or enter a custom id

# 3. Run a scenario (a built-in name, a workspace scenario, or stdin text)
dublo run homepage-smoke --workspace ./.dublo
echo "Sign in with the QA account and confirm the dashboard loads." | dublo run --workspace ./.dublo

# 4. Read the report
dublo report show        # defaults to the latest run
dublo report open        # opens the HTML report
```

During local development of Dublo itself, build first and use the compiled CLI:
`npm run build && node dist/cli.js run homepage-smoke --workspace ./.dublo`.

## The mental model

- **Workspace** (`./.dublo` by default): `defaults.json` plus folders `llm/`,
  `personas/`, `scenarios/`, `context/`, `blocks/`, and an optional `prompt.md`
  (app-specific background injected into every run).
- **Scenario**: the objective + success criteria, in plain language. From a
  workspace file, a built-in template, `--adhoc "..."`, or stdin.
- **Persona**: how the agent behaves and what it treats as a defect
  (`qa-strict`, `exploratory`, `accessibility`, `performance`, or your own).
- **Context & secrets**: data the agent fills forms with. Non-secret context via
  `--context`/`--set`/`--json` and `{{context:path}}`; secrets never sent to the
  planner via `--secret`/`DUBLO_SECRET_*` and `{{secret:path}}`.
- **Observation**: a ranked list of controls with rich state (label, role,
  value, checked, required, `nameSource`/`confidence`, `inferred`, `offscreen`,
  `focused`), plus headings, alerts, visible text, scroll containers, `focus`,
  `modal`, `runtimeErrors` (console/network/dialog signals), and a `truncated`
  flag. No screenshots unless the agent asks (`request_screenshot`, delivered
  with numbered set-of-marks).
- **Actions**: one action or a validated batch per turn. See the action list in
  the reference. Batches re-validate each action against the live DOM and abort
  on any mismatch.
- **Report**: `report.json` + Markdown/HTML, with per-step detail, `findings`,
  `runtimeErrors`, `tokenUsage`, and a `costEstimate`.

## Choosing settings for the goal

| Goal | Persona | Key settings |
| --- | --- | --- |
| Functional / regression pass | `qa-strict` | `--init` a recorded block for setup; deterministic assertions |
| Accessibility audit | `accessibility` | keep `interactionScope: viewport`; watch `confidence`/`nameSource`, unnamed controls, turn-level `findings` |
| Usability / exploratory | `exploratory` | `viewport` scope (test real reachability) |
| Performance / responsiveness | `performance` | `--screenshots none`; watch settle/loading and `runtimeErrors` |
| Bulk data entry / automation | `qa-strict` | `interactionScope: document`, large or `0` `maxControls`, batching on (default) |

## Cost tuning (low-price models)

Apply in this order — each is documented in the reference:

1. **Prompt caching** — set `promptCaching: true` on a Bedrock profile. Caches
   the large stable prefix (system + persona + scenario + rules) every step.
   Biggest single lever.
2. **Two-tier routing** — set `escalationLlm` to a stronger profile; a cheap
   model drives and escalates only on failure/truncation/`give_up`.
3. **Batching** (on by default) — the agent fills whole forms / toggles many
   rows in one model call. `maxActionsPerTurn: 0` = unlimited, `1` = disable.
4. **Control budget** — `maxControls` (default 150, `0` = unlimited) with
   relevance ranking so truncation keeps useful controls.
5. **Screenshots off** — `--screenshots none` (default) unless you need the
   vision fallback.

## Common recipes

**Fill a form fast:** the agent batches `fill … fill … click Submit` in one
turn automatically. For fields below the fold, run with
`interactionScope: document` so it can target them without scrolling.

**Record once, replay as regression:**
```bash
dublo run checkout --workspace ./.dublo          # a passing LLM-driven run
dublo block import checkout-setup                 # build a reusable block from it
dublo run checkout --init checkout-setup          # replay deterministically; self-heals on drift
```

**Cheapest reliable setup:** cheap Bedrock profile with `promptCaching: true`,
an `escalationLlm` pointing at a stronger profile, batching left on,
`--screenshots none`.

**Provide login data without leaking it:**
```bash
DUBLO_SECRET_password='…' dublo run login --set user.email=qa@example.com
```
The planner sees `user.email` and the secret *path* but never the password
value; the agent fills it with `{{secret:password}}`.

## Troubleshooting

- **Agent can't find a control** → it may be off-viewport (`interactionScope:
  document`), in shadow DOM (piercing is on by default), a non-semantic
  clickable (inferred; check `includeInferredControls`), or truncated (watch
  `truncated`; raise `maxControls` or set `0`).
- **Blocked on a value it can't know** (OTP, CAPTCHA) → it uses
  `request_user_input`/`request_user_interaction`; only works in headed mode.
- **Run fails at "max steps"** → raise `max-steps`, or record setup as an
  `--init` block so the LLM spends steps only on the new part.
- **Costs too high** → apply the cost-tuning list above; inspect
  `report.json` `tokenUsage` and `costEstimate`.
- **Flaky selectors / drift on replay** → blocks store descriptive targets and
  self-heal; a URL post-condition fails the run loudly on divergence.

Always confirm exact option names, defaults, and field shapes against
`references/reference.md`.
