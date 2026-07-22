import assert from "node:assert/strict";
import test from "node:test";
import { createBedrockPlanner } from "../../src/node/bedrock-planner.js";

const messages = {
  systemText: "system",
  staticContextText: "",
  dynamicContextText: "dynamic"
};

void test("Bedrock planner validates tool-use actions through an injected client", async () => {
  const requests: unknown[] = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
    {
      client: {
        send(command) {
          requests.push(command.input);
          return Promise.resolve({
            usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "Success criteria are visible.",
                        payload: { action: "finish" }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "Success criteria are visible.",
    payload: { action: "finish" }
  });
  assert.deepEqual(response.tokenUsage, {
    inputTokens: 8,
    outputTokens: 3,
    totalTokens: 11,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0
  });
  assert.equal(requests.length, 1);
  const requestJson = JSON.stringify(requests[0]);
  assert.match(requestJson, /"toolConfig"/);
  assert.match(requestJson, /"toolConfig":\{"tools"/);
  assert.match(requestJson, /"toolChoice":\{"tool":\{"name":"planner_action"/);
  assert.match(requestJson, /"expectGone"/);
  assert.match(requestJson, /"documentText"/);
  assert.match(requestJson, /"target"/);
  assert.match(
    requestJson,
    /"target":\{"type":"object","additionalProperties":false,"required":\["id"\],"properties":\{"id"/
  );
  assert.doesNotMatch(requestJson, /"ariaLabel"/);
  assert.match(requestJson, /"give_up"/);
  assert.match(requestJson, /"text":"dynamic"/);
  assert.doesNotMatch(requestJson, /"text":""/);
  assert.doesNotMatch(requestJson, /"strict":true/);
  assert.doesNotMatch(requestJson, /"inferenceConfig"/);
});

void test("Bedrock planner forwards configured inference settings without a token default", async () => {
  const requests: unknown[] = [];
  const planner = createBedrockPlanner(
    {
      modelId: "test-model",
      region: "us-east-1",
      inferenceConfig: { temperature: 0, maxTokens: 1400 }
    },
    {
      client: {
        send(command) {
          requests.push(command.input);
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "Success criteria are visible.",
                        payload: { action: "finish" }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  await planner.nextAction({ messages });

  assert.deepEqual((requests[0] as { inferenceConfig?: unknown }).inferenceConfig, {
    temperature: 0,
    maxTokens: 1400
  });
});

void test("Bedrock planner enables strict tool validation when the model supports it", async () => {
  const requests: unknown[] = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1", supportsStrictToolUse: true },
    {
      client: {
        send(command) {
          requests.push(command.input);
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "Success criteria are visible.",
                        payload: { action: "finish" }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  await planner.nextAction({ messages });

  const requestJson = JSON.stringify(requests[0]);
  assert.match(requestJson, /"strict":true/);
  assert.match(
    requestJson,
    /"json":\{"type":"object","additionalProperties":false,"required":\["reason","payload"\]/
  );
  assert.match(requestJson, /"payload":\{"anyOf"/);
  assert.match(
    requestJson,
    /"target":\{"type":"object","additionalProperties":false,"required":\["id"\],"properties":\{"id"/
  );
  assert.doesNotMatch(requestJson, /"ariaLabel"/);
  assert.match(
    requestJson,
    /"required":\["action","interactionPrompt"\][\s\S]*"const":"request_user_interaction"/
  );
  assert.match(
    requestJson,
    /"required":\["action","screenshotPrompt"\][\s\S]*"const":"request_screenshot"/
  );
  assert.match(
    requestJson,
    /"required":\["action","containerId","direction"\][\s\S]*"const":"scroll"/
  );
  assert.match(
    requestJson,
    /"required":\["action","target","value"\][\s\S]*"const":"select_option"/
  );
});

void test("Bedrock planner preserves strict action payloads", async () => {
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1", supportsStrictToolUse: true },
    {
      client: {
        send() {
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "The structured observation is insufficient.",
                        payload: {
                          action: "request_screenshot",
                          screenshotPrompt: "Show the open menu."
                        }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action, {
    reason: "The structured observation is insufficient.",
    payload: { action: "request_screenshot", screenshotPrompt: "Show the open menu." }
  });
});

void test("Bedrock planner normalizes compound targets to their ID", async () => {
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
    {
      client: {
        send() {
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "Open the routine form.",
                        payload: { action: "click", target: { id: "a1", text: "New Routine" } }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  const response = await planner.nextAction({ messages });

  assert.deepEqual(response.action.payload, { action: "click", target: { id: "a1" } });
});

void test("Bedrock planner preflight sends the planner tool definition", async () => {
  const requests: unknown[] = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1", supportsStrictToolUse: true },
    {
      client: {
        send(command) {
          requests.push(command.input);
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: { reason: "Preflight.", payload: { action: "finish" } }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  await planner.preflight();

  const requestJson = JSON.stringify(requests[0]);
  assert.match(requestJson, /"planner_action"/);
  assert.match(requestJson, /"strict":true/);
  assert.match(requestJson, /"required":\["reason","payload"\]/);
});

void test("Bedrock planner rejects resolved error responses", async () => {
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
    {
      client: {
        send() {
          return Promise.resolve({
            errorCode: "ValidationException",
            message: "Schema is too complex.",
            $metadata: { httpStatusCode: 400, requestId: "request-123" }
          });
        }
      }
    }
  );

  await assert.rejects(
    () => planner.preflight(),
    /ValidationException: Schema is too complex\. \(request ID request-123\)/
  );
});

void test("Bedrock planner identifies malformed actions without exposing their values", async () => {
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
    {
      client: {
        send() {
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: {
                        reason: "Click the control.",
                        payload: { action: "click", target: { id: "new-routine" }, value: "secret" }
                      }
                    }
                  }
                ]
              }
            }
          });
        }
      }
    }
  );

  await assert.rejects(
    () => planner.nextAction({ messages }),
    /invalid 'click' action with fields \[payload, reason\][\s\S]*value/
  );
});
