import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { runScenario } from "../../src/utils/scenario-runner.mjs";

const FORM_HTML = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <form onsubmit="event.preventDefault();document.getElementById('done').textContent='Signed in';">
    <input aria-label="Email" id="email" />
    <input aria-label="Password" id="password" type="password" />
    <button type="submit">Sign in</button>
  </form>
  <div id="done"></div>
</body></html>`;

type PlannerFn = (body: string, plannerCall: number) => Record<string, unknown>;
type ServerHandle = {
  server: Server;
  baseUrl: string;
  plannerCalls: () => number;
  requestBodies: () => string[];
};

// Serves the sign-in page and a fake OpenAI-compatible planner whose turns are
// produced by the supplied function (preflight calls are answered separately
// and not counted).
function startFakeServer(nextTurn: PlannerFn, pageHtml: string = FORM_HTML): Promise<ServerHandle> {
  let plannerCalls = 0;
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageHtml);
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const isPreflight = body.includes("Return exactly this JSON");
      let turn: Record<string, unknown>;
      if (isPreflight) {
        turn = { reason: "Preflight.", actions: [{ action: "finish" }] };
      } else {
        plannerCalls += 1;
        requestBodies.push(body);
        turn = nextTurn(body, plannerCalls);
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "planner_action", arguments: JSON.stringify(turn) } }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        plannerCalls: () => plannerCalls,
        requestBodies: () => requestBodies
      });
    });
  });
}

type Report = {
  status: string;
  error?: string;
  tokenUsage: { formatRetries: number };
  findings: Array<{
    step: number;
    severity: string;
    category: string;
    summary: string;
    reason: string;
  }>;
  steps: Array<{
    index: number;
    name: string;
    phase?: string;
    plannerModel?: string;
    observation?: unknown;
    observationSharedFromStep?: number;
    plannerTokenUsage?: unknown;
  }>;
};

async function runAgainst(
  handle: ServerHandle,
  overrides: Record<string, unknown> = {}
): Promise<Report> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "dublo-repair-"));
  try {
    return (await runScenario({
      baseUrl: `${handle.baseUrl}/`,
      scenario: "Sign in to the application.",
      maxSteps: 8,
      settleDelayMs: 1,
      settleTimeoutMs: 300,
      headed: false,
      debug: false,
      screenshots: "none",
      reports: [],
      outputDir,
      contextOperations: [],
      workspacePromptFile: "",
      personaFile: "",
      observationConfigFile: "",
      llm: {
        provider: "openai-compatible",
        baseUrl: `${handle.baseUrl}/v1`,
        modelId: "fake-model"
      },
      ...overrides
    })) as Report;
  } finally {
    await rm(outputDir, { force: true, recursive: true });
  }
}

// The state-aware planner used once a test's special turns are exhausted: it
// batches every remaining sign-in step, then finishes.
function remainingSignInTurn(body: string): Record<string, unknown> {
  const remaining: Array<Record<string, unknown>> = [];
  if (!body.includes("user@example.com")) {
    remaining.push({ action: "fill", target: { label: "Email" }, value: "user@example.com" });
  }
  if (!body.includes("hunter2")) {
    remaining.push({ action: "fill", target: { label: "Password" }, value: "hunter2" });
  }
  if (!body.includes("Signed in")) {
    remaining.push({ action: "click", target: { text: "Sign in" } });
  }
  return remaining.length === 0
    ? { reason: "Done.", actions: [{ action: "finish" }] }
    : { reason: "Complete and submit the sign-in form.", actions: remaining };
}

void test("a schema-invalid turn is retried with validation feedback instead of failing the run", async (t) => {
  const handle = await startFakeServer((body, call) =>
    // First turn is invalid: fill without a value. Every later turn is valid.
    call === 1
      ? {
          reason: "Fill the email field.",
          actions: [{ action: "fill", target: { label: "Email" } }]
        }
      : remainingSignInTurn(body)
  );
  t.after(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));

  const report = await runAgainst(handle);

  assert.equal(report.status, "passed");
  assert.equal(report.tokenUsage.formatRetries, 1);
  // The retry request carried the validation message back to the model.
  const retryBody = handle.requestBodies()[1];
  assert.ok(retryBody);
  assert.match(retryBody, /failed schema validation/);

  // The failed attempt is its own visible step in the report.
  const repairStep = report.steps.find((step) => step.name === "planner_invalid_turn");
  assert.ok(repairStep, "expected a planner_invalid_turn step");
  assert.equal(repairStep.phase, "planner_repair");
  assert.equal(repairStep.plannerModel, "fake-model");
  // Normal steps record which model planned them.
  const fillStep = report.steps.find((step) => step.name.startsWith("fill_"));
  assert.ok(fillStep);
  assert.equal(fillStep.plannerModel, "fake-model");
});

void test("a turn that stays invalid after the retry fails the run with the parse error", async (t) => {
  const handle = await startFakeServer(() => ({
    reason: "Fill the email field.",
    actions: [{ action: "fill", target: { label: "Email" } }]
  }));
  t.after(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));

  const report = await runAgainst(handle);
  // runScenario marks the process exit code for a failed run; this failure is
  // the expected outcome under test, not a test-suite failure.
  process.exitCode = 0;

  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /invalid turn/);
  // One retry was attempted (no escalation model is configured here).
  assert.equal(report.tokenUsage.formatRetries, 1);
  assert.equal(handle.plannerCalls(), 2);
});

void test("turn-level findings are recorded alongside the executed action", async (t) => {
  const handle = await startFakeServer((body, call) =>
    call === 1
      ? {
          reason: "Record the defect and start filling the form.",
          findings: [
            {
              severity: "major",
              category: "accessibility",
              summary: "Sign-in button has no accessible name."
            }
          ],
          actions: [{ action: "fill", target: { label: "Email" }, value: "user@example.com" }]
        }
      : remainingSignInTurn(body)
  );
  t.after(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));

  const report = await runAgainst(handle);

  assert.equal(report.status, "passed");
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.ok(finding);
  assert.equal(finding.severity, "major");
  assert.equal(finding.category, "accessibility");
  assert.equal(finding.summary, "Sign-in button has no accessible name.");
  assert.equal(finding.reason, "Record the defect and start filling the form.");
  // The finding is anchored to the step whose turn carried it.
  const fillStep = report.steps.find((step) => step.name.startsWith("fill_"));
  assert.ok(fillStep);
  assert.equal(finding.step, fillStep.index);
});

void test("batch follow-on steps record a pointer to the shared observation in debug mode", async (t) => {
  const handle = await startFakeServer((body) => remainingSignInTurn(body));
  t.after(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));

  const report = await runAgainst(handle, { debug: true });

  assert.equal(report.status, "passed");
  const primaryStep = report.steps.find((step) => step.name.startsWith("fill_"));
  assert.ok(primaryStep);
  assert.ok(primaryStep.observation, "primary step should carry the full observation");

  const batchSteps = report.steps.filter((step) => step.phase === "batch");
  assert.ok(batchSteps.length >= 2);
  for (const step of batchSteps) {
    // A pointer, not a copy: the shared observation lives on the primary step,
    // and the planner call's token usage is not duplicated onto follow-ons.
    assert.equal(step.observationSharedFromStep, primaryStep.index);
    assert.equal(step.observation, undefined);
    assert.equal(step.plannerTokenUsage, undefined);
  }
});

const DUPLICATE_BUTTONS_HTML = `<!doctype html><html><body>
  <button>Add task</button>
  <section><button>Add task</button></section>
</body></html>`;

void test("an ambiguous selector is recoverable and feeds disambiguation guidance back", async (t) => {
  const handle = await startFakeServer(
    (body, call) =>
      call === 1
        ? {
            reason: "Click the add button.",
            actions: [{ action: "click", target: { text: "Add task" } }]
          }
        : { reason: "Done.", actions: [{ action: "finish" }] },
    DUPLICATE_BUTTONS_HTML
  );
  t.after(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));

  const report = await runAgainst(handle);

  // The run survives the ambiguity instead of aborting.
  assert.equal(report.status, "passed");
  const clickStep = report.steps.find((step) => step.name.startsWith("click_"));
  assert.ok(clickStep, "expected the ambiguous click step in the report");

  // The next planner turn is told which candidates matched and how to fix it.
  const followUpBody = handle.requestBodies()[1];
  assert.ok(followUpBody);
  assert.match(followUpBody, /matched 2 controls/);
  assert.match(followUpBody, /ambiguous_target/);
  assert.match(followUpBody, /ids are unique within an observation/);

  // The id-first selector guidance is present even though this profile does
  // NOT set supportsStrictToolUse - the wording is no longer gated on it.
  const firstBody = handle.requestBodies()[0];
  assert.ok(firstBody);
  assert.match(firstBody, /Add no selector field beyond id and label/);
  assert.match(firstBody, /Address controls by id/);
  // The id+label verification rule must actually be asked for, otherwise
  // target_field_mismatch only fires when the model disobeys instructions.
  assert.match(firstBody, /include that control's label copied EXACTLY/);
});
