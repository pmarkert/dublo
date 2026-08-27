import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScenario } from "../../src/utils/scenario-runner.mjs";

const PAGE_HTML = `<!doctype html><html><body><h1>Home</h1><button>Click me</button></body></html>`;

// A local stand-in for an OpenAI-compatible endpoint that also serves the page
// under test. It returns a click on the real button when asked to self-heal a
// recorded step, and finish otherwise.
function startFakeServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(PAGE_HTML);
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const isHeal = body.includes("Reproduce a recorded regression step");
      const action = isHeal
        ? {
            reason: "Re-grounded the recorded click.",
            actions: [{ action: "click", target: { text: "Click me" } }]
          }
        : { reason: "Objective satisfied.", actions: [{ action: "finish" }] };
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "planner_action", arguments: JSON.stringify(action) } }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

void test("self-heals a recorded block step whose target no longer resolves", async (t) => {
  const { server, baseUrl } = await startFakeServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "dublo-selfheal-"));
  t.after(async () => rm(outputDir, { force: true, recursive: true }));

  const report = (await runScenario({
    baseUrl: `${baseUrl}/`,
    scenario: "Confirm the page loaded.",
    maxSteps: 3,
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
    llm: { provider: "openai-compatible", baseUrl: `${baseUrl}/v1`, modelId: "fake-model" },
    initBlocks: [
      {
        name: "recorded",
        actions: [
          {
            reason: "Click the primary button.",
            payload: { action: "click", target: { label: "This Label No Longer Exists" } }
          }
        ]
      }
    ]
  })) as { status: string; tokenUsage: { selfHealCalls: number } };

  assert.equal(report.status, "passed");
  // The recorded target did not resolve, so exactly one self-heal planner call ran.
  assert.equal(report.tokenUsage.selfHealCalls, 1);
});

void test("flags control drift when a recorded step matches by description but the control changed", async (t) => {
  const { server, baseUrl } = await startFakeServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "dublo-drift-"));
  t.after(async () => rm(outputDir, { force: true, recursive: true }));

  const run = (fingerprint?: string) =>
    runScenario({
      baseUrl: `${baseUrl}/`,
      scenario: "Confirm the page loaded.",
      maxSteps: 3,
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
      llm: { provider: "openai-compatible", baseUrl: `${baseUrl}/v1`, modelId: "fake-model" },
      initBlocks: [
        {
          name: "recorded",
          actions: [
            {
              reason: "Click the primary button.",
              payload: { action: "click", target: { label: "Click me" } },
              ...(fingerprint ? { fingerprint } : {})
            }
          ]
        }
      ]
    }) as Promise<{
      status: string;
      controlDrift: number;
      steps: Array<{ name: string; fingerprint?: string; controlDrift?: boolean }>;
    }>;

  // A block recorded against a different control identity: the description
  // still matches the live button, so the step runs - and is flagged.
  const drifted = await run("deadbeef");
  assert.equal(drifted.status, "passed");
  assert.equal(drifted.controlDrift, 1);
  const driftedStep = drifted.steps.find((step) => step.name.startsWith("init_recorded_"));
  assert.ok(driftedStep);
  assert.equal(driftedStep.controlDrift, true);
  // The live fingerprint is recorded on the step, so a re-import captures it.
  assert.ok(driftedStep.fingerprint);

  // Replaying with the fingerprint the page actually has: no drift.
  const clean = await run(driftedStep.fingerprint);
  assert.equal(clean.status, "passed");
  assert.equal(clean.controlDrift, 0);
  assert.notEqual(
    clean.steps.find((step) => step.name.startsWith("init_recorded_"))?.controlDrift,
    true
  );

  // A block with no recorded fingerprint (imported before this existed) is
  // replayed without a drift check rather than warning spuriously.
  const legacy = await run(undefined);
  assert.equal(legacy.controlDrift, 0);
});
