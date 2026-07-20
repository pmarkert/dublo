# Reusable Initialization Blocks

## Status

Partially implemented. `block import`, `list`, `show`, `edit`, and `validate` manage validated reusable action lists. Replaying those blocks through `dublo run --init` remains pending.

## Problem

Repeated setup flows currently consume LLM calls on every scenario run. A login flow is a typical example: the LLM must rediscover the same controls, fill known values, submit the form, and decide when an intermediate loading screen has completed.

The desired end state is to record a successful deterministic prefix from a report and replay it before the LLM starts the scenario-specific portion of a future run. A future My Day scenario should therefore replay login, wait until the authenticated application is ready, collect a fresh observation, and only then ask the LLM to navigate to and verify My Day.

## Current Example

The report `2026-07-20T17-58-27-724Z_pass_myday` has this useful split:

| Steps | Purpose | Future role |
| --- | --- | --- |
| 1 | Navigate to the configured base URL | Remains runner startup behavior |
| 2-5 | Fill email, continue, fill password, submit sign-in | Reusable login block |
| 6 | Wait while the application displays `Checking your account...` | Replace with deterministic readiness wait |
| 7 | Click My Day | Scenario-specific LLM action |

Step 6 is why a recorded fixed-duration wait is not sufficient. The current planner `wait` action sleeps for a fixed interval, then subsequent looping and settling decide whether the page is usable. If authentication takes longer on another run, a replayed sleep can proceed too early; if it is faster, it wastes time.

## Prerequisite: Condition-Based Waiting

Introduce a first-class `wait_until_gone` action that can be selected by the LLM and replayed from an initialization block. It waits for a visible, currently observed blocker to disappear rather than sleeping for a fixed duration or predicting an unknown future state.

The initial action should support a small, validated condition vocabulary:

```json
{
  "action": "wait_until_gone",
  "reason": "Authentication is still loading.",
  "expectGone": {
    "documentText": "Checking your account..."
  }
}
```

The runner owns polling, the configured settle delay, and the configured settle timeout. It returns the LLM a new observation as soon as the text has remained absent for the settle delay. A timeout reports the remaining document text to the LLM; the same timed-out condition cannot be repeated without a UI action or URL change.

The LLM schema intentionally accepts only observed document text. It does not accept arbitrary CSS selectors, JavaScript expressions, fixed delays, or a predicted destination state. The runner automatically settles ordinary UI transitions and URL changes before every LLM observation, so the LLM only uses `wait_until_gone` for a persistent visible blocker.

## Proposed Initialization Block Model

After `wait_until_gone` is available, add a workspace directory and commands:

```text
<workspace>/blocks/login.json

dublo block import login
dublo block import login 2026-07-20T17-58-27-724Z_pass_myday
dublo block show login
dublo block validate login
dublo run myday --init login
```

Use `block` as the command namespace because `init` is already the workspace creation command. `--init` names a block's execution phase, and should eventually be repeatable.

A block is an executable, versioned action list. It is not a saved planner transcript or prompt. Imported blocks retain optional source provenance for review, but manually authored blocks do not require it. `block import` defaults to the latest run and requires it to have passed; it imports successful replayable steps after runner startup navigation, while terminal and failed actions are omitted.

```json
{
  "version": 1,
  "name": "login",
  "source": {
    "runId": "2026-07-20T17-58-27-724Z_pass_myday",
    "steps": [2, 3, 4, 5, 6]
  },
  "actions": [
    {
      "action": "fill",
      "targetId": "a2",
      "value": "{{context:login.email}}",
      "reason": "Enter the account email."
    },
    {
      "action": "click",
      "targetId": "a3",
      "reason": "Continue to password entry."
    },
    {
      "action": "fill",
      "targetId": "a2",
      "value": "{{secret:password}}",
      "reason": "Enter the account password."
    },
    {
      "action": "click",
      "targetId": "a4",
      "reason": "Submit sign-in."
    },
    {
      "action": "wait_until_gone",
      "expectGone": {
        "documentText": [
          "Checking your account...",
          "Still loading your details..."
        ]
      },
      "reason": "Wait for the authentication loading state to disappear."
    }
  ]
}
```

The runner flow becomes:

```text
navigate to base URL
replay init block actions without planner calls
collect a fresh observation
start the normal LLM scenario loop
```

Initialization steps should remain visible in reports and be marked with `phase: "init"` and their block name. Their token cost is zero. The first planner request receives the new post-initialization observation and the scenario objective, not the old login observations or reasons.

## Execution Rules

- Replay must use the same action execution code as planner actions: target lookup, context and secret placeholder resolution, settling, artifact capture, and interruption handling.
- Blocks may initially contain only `click`, `fill`, and `wait_until_gone`. Reject `finish`, user-input requests, interaction requests, and screenshot requests during recording and validation.
- `maxSteps` remains the LLM action budget. Initialization has a separate hard action limit and an overall timeout.
- Record only successful steps from a successful report. Preserve action templates such as `{{secret:password}}`; never export resolved secret values.
- Flag literal `fill` values during validation and recommend context or secret placeholders where applicable.
- A missing target or failed readiness condition is a block failure. Do not fall back to the LLM within the first version, because that makes the result nondeterministic and obscures a stale block.
- Planner actions always contain one observed `expectGone.documentText`. Imported blocks retain that string, but users may edit it into a list of alternate transient texts. The wait completes only after every listed text is absent.

## Target Identity Limitation

The current `a1`, `a2`, and similar identifiers are assigned during each fresh observation, rather than being persistent page-owned DOM IDs. Replay must collect a fresh observation before each action and use the recorded target ID against that observation. If the observed control ordering changes, replay can fail; this is an accepted initial constraint, provided the error identifies the block, action index, expected target, and current URL.

If this proves too brittle, add stable selector metadata during block recording as a later design iteration. Do not introduce it before evidence shows that the present IDs are insufficient.

## Delivery Sequence

1. Add and validate `wait_until_gone` to the planner action schema and action dispatcher.
2. Add prompt guidance so the LLM chooses `wait_until_gone` for persistent observable blockers instead of fixed sleeps.
3. Add runner tests for successful disappearance, delayed disappearance, timeout, stability, and duplicate-wait protection.
4. Confirm the login flow can use `wait_until_gone` reliably over repeated runs.
5. Implement the block schema, storage, recording command, and validation.
6. Extract shared deterministic action execution and add `--init` replay.
7. Add reporting metadata and end-to-end replay tests.

## Risks and Decisions

- Loading states vary in duration: solve this with bounded readiness checks, not longer fixed sleeps.
- UI changes can invalidate target IDs: fail loudly during the first version rather than silently replanning.
- Replaying mutating flows can create duplicate data: document blocks as suitable for idempotent setup flows such as login, and consider explicit idempotency metadata before supporting broader workflows.
- Future persistent browser sessions may find the user already authenticated: begin with strict replay behavior, then add optional preconditions or skips only when a concrete workflow requires them.
- Keep secrets isolated: block files may contain placeholders but never resolved values, screenshots, observations, or saved planner prompts.