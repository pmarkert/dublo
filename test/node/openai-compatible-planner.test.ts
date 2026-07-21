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
                        reason: "Continue the visible flow.",
                        payload: { action: "click", target: { id: "button-1" } }
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
    reason: "Continue the visible flow.",
    payload: { action: "click", target: { id: "button-1" } }
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
  assert.match(requestBody, /expectGone/);
  assert.match(requestBody, /documentText/);
});

void test("OpenAI-compatible planner accepts a structured wait-until-gone action", async () => {
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
                      arguments: JSON.stringify({
                        reason: "Authentication is still loading.",
                        payload: {
                          action: "wait_until_gone",
                          expectGone: { documentText: "Checking your account..." }
                        }
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
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "Authentication is still loading.",
    payload: { action: "wait_until_gone", expectGone: { documentText: "Checking your account..." } }
  });
});

void test("OpenAI-compatible planner accepts a give-up action", async () => {
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
                      arguments: JSON.stringify({
                        reason:
                          "The required control is not visible and no safe action can reveal it.",
                        payload: { action: "give_up" }
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
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "The required control is not visible and no safe action can reveal it.",
    payload: { action: "give_up" }
  });
});

void test("OpenAI-compatible planner accepts a scroll action", async () => {
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
                      arguments: JSON.stringify({
                        reason: "More routine options are below the visible form area.",
                        payload: { action: "scroll", containerId: "s1", direction: "down" }
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
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "More routine options are below the visible form area.",
    payload: { action: "scroll", containerId: "s1", direction: "down" }
  });
});

void test("OpenAI-compatible planner accepts a select-option action", async () => {
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
                      arguments: JSON.stringify({
                        reason: "Set the routine frequency from the observed choices.",
                        payload: {
                          action: "select_option",
                          target: { id: "a4" },
                          value: "weekdays"
                        }
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
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "Set the routine frequency from the observed choices.",
    payload: { action: "select_option", target: { id: "a4" }, value: "weekdays" }
  });
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
                      arguments: JSON.stringify({
                        reason: "Click it.",
                        payload: { action: "click" }
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
  const planner = createOpenAICompatiblePlanner(
    { baseUrl: "http://planner.test/v1", modelId: "test-model" },
    { fetch: fetchStub }
  );

  await assert.rejects(() => planner.nextAction({ messages }), /target[\s\S]*Invalid input/);
});
