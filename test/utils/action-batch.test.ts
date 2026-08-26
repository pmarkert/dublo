import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type ServerHandle = { server: Server; baseUrl: string; plannerTurns: () => number };

function startFakeServer(): Promise<ServerHandle> {
  let plannerTurns = 0;
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(FORM_HTML);
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const isPreflight = body.includes("Return exactly this JSON");
      if (!isPreflight) plannerTurns += 1;

      // State-aware planner: it always proposes every remaining step as a batch,
      // computed from the current observation. With batching on, one turn
      // completes the form; with batching off, each turn advances one step.
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
      const turn =
        isPreflight || remaining.length === 0
          ? { reason: "Done.", actions: [{ action: "finish" }] }
          : { reason: "Complete and submit the sign-in form.", actions: remaining };

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
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, plannerTurns: () => plannerTurns });
    });
  });
}

type Report = {
  status: string;
  steps: Array<{ name: string; phase?: string; plannerAction?: { payload: { action: string } } }>;
};

async function runWith(
  maxActionsPerTurn: number | undefined
): Promise<{ report: Report; turns: number }> {
  const handle = await startFakeServer();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "dublo-batch-"));
  try {
    const report = (await runScenario({
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
      ...(maxActionsPerTurn === undefined ? {} : { maxActionsPerTurn }),
      llm: { provider: "openai-compatible", baseUrl: `${handle.baseUrl}/v1`, modelId: "fake-model" }
    })) as Report;
    return { report, turns: handle.plannerTurns() };
  } finally {
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await rm(outputDir, { force: true, recursive: true });
  }
}

void test("executes a batched turn as multiple steps from one planner call", async () => {
  const { report, turns } = await runWith(undefined);

  assert.equal(report.status, "passed");

  // Two fills and a click were all executed, and the follow-ons are marked as
  // batch steps.
  const executed = report.steps
    .filter((step) => step.plannerAction)
    .map((step) => step.plannerAction!.payload.action);
  assert.equal(executed.filter((action) => action === "fill").length, 2);
  assert.equal(executed.filter((action) => action === "click").length, 1);
  assert.ok(report.steps.some((step) => step.phase === "batch"));

  // The three UI actions plus the finish came from just two planner turns.
  assert.equal(turns, 2);
});

void test("maxActionsPerTurn of 1 disables batching", async () => {
  const { report, turns } = await runWith(1);

  assert.equal(report.status, "passed");
  // No batch steps, and each UI action cost its own planner turn.
  assert.equal(
    report.steps.some((step) => step.phase === "batch"),
    false
  );
  assert.ok(turns > 2);
});
