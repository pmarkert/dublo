import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatiblePlanner } from "../../src/node/openai-compatible-planner.js";

const messages = {
  systemText: "system",
  staticContextText: "static",
  dynamicContextText: "dynamic"
};

void test("OpenAI-compatible planner validates a tool-call action and token usage", async () => {
  const requests: RequestInit[] = [];
  const fetchStub: typeof fetch = (_input, init) => {
    if (init) requests.push(init);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({
                        action: "click",
                        targetId: "button-1",
                        reason: "Continue the visible flow."
                      })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
  };
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  const response = await planner.nextAction({
    messages,
    screenshot: new Uint8Array([137, 80, 78, 71])
  });

  assert.deepEqual(response.action, {
    action: "click",
    targetId: "button-1",
    reason: "Continue the visible flow."
  });
  assert.deepEqual(response.tokenUsage, {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0
  });
  assert.equal(requests.length, 1);
  const requestBody = requests[0]?.body;
  assert.equal(typeof requestBody, "string");
  assert.match(requestBody, /data:image\/png;base64/);
});

void test("OpenAI-compatible planner rejects an invalid action before browser execution", async () => {
  const fetchStub: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({ action: "click", reason: "Click it." })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  await assert.rejects(
    () => planner.nextAction({ messages }),
    /click and fill actions require targetId/
  );
});
