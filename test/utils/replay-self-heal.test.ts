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
