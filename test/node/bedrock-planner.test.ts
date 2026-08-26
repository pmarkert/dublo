import assert from "node:assert/strict";
import test from "node:test";
import { createBedrockPlanner } from "../../src/node/bedrock-planner.js";

const messages = {
  systemText: "system",
  staticContextText: "static",
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
                        actions: [{ action: "finish" }]
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
    actions: [{ action: "finish" }]
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
  assert.match(requestJson, /"give_up"/);
  assert.doesNotMatch(requestJson, /"strict":true/);
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
                        actions: [{ action: "finish" }]
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
    /"json":\{"type":"object","additionalProperties":false,"required":\["reason","actions"\]/
  );
  assert.match(requestJson, /"actions":\{"type":"array","minItems":1,"items":\{"anyOf"/);
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
                        actions: [
                          {
                            action: "request_screenshot",
                            screenshotPrompt: "Show the open menu."
                          }
                        ]
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
    actions: [{ action: "request_screenshot", screenshotPrompt: "Show the open menu." }]
  });
});

void test("Bedrock planner accepts a report_finding action", async () => {
  const requests: unknown[] = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
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
                        reason: "The control cannot be identified by assistive tech.",
                        actions: [
                          {
                            action: "report_finding",
                            severity: "major",
                            category: "accessibility",
                            summary: "Icon-only button has no accessible name."
                          }
                        ]
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
    reason: "The control cannot be identified by assistive tech.",
    actions: [
      {
        action: "report_finding",
        severity: "major",
        category: "accessibility",
        summary: "Icon-only button has no accessible name."
      }
    ]
  });
  assert.match(JSON.stringify(requests[0]), /"const":"report_finding"/);
});

void test("Bedrock planner inserts cache points when prompt caching is enabled", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1", promptCaching: true },
    {
      client: {
        send(command) {
          requests.push(command.input as Record<string, unknown>);
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: { reason: "Done.", actions: [{ action: "finish" }] }
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

  const input = requests[0];
  const system = input.system as Array<Record<string, unknown>>;
  const userContent = (input.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
    .content;

  // The system prompt is cached, then the static context, so the stable prefix
  // (system + static) is read from cache on every subsequent turn.
  assert.deepEqual(system[system.length - 1], { cachePoint: { type: "default" } });
  const staticIndex = userContent.findIndex((block) => block.text === "static");
  assert.deepEqual(userContent[staticIndex + 1], { cachePoint: { type: "default" } });
  // The dynamic context stays outside the cached prefix.
  assert.equal(userContent[staticIndex + 2].text, "dynamic");
});

void test("Bedrock planner omits cache points by default", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1" },
    {
      client: {
        send(command) {
          requests.push(command.input as Record<string, unknown>);
          return Promise.resolve({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "planner_action",
                      input: { reason: "Done.", actions: [{ action: "finish" }] }
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

  assert.doesNotMatch(JSON.stringify(requests[0]), /cachePoint/);
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
                      input: { reason: "Preflight.", actions: [{ action: "finish" }] }
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
  assert.match(requestJson, /"required":\["reason","actions"\]/);
  // The preflight must leave room for the whole forced tool call; too tight a
  // budget truncates it mid-sequence and Nova rejects the invalid ToolUse.
  assert.match(requestJson, /"maxTokens":256/);
});

void test("Bedrock planner preflight fails loudly on a truncated (empty) tool call", async () => {
  // A too-tight token budget can truncate the toolUse so the endpoint returns
  // an empty `{}` input. That must not rubber-stamp the model: preflight has to
  // verify a complete, well-formed planner_action.
  const planner = createBedrockPlanner(
    { modelId: "test-model", region: "us-east-1", supportsStrictToolUse: true },
    {
      client: {
        send() {
          return Promise.resolve({
            output: {
              message: {
                content: [{ toolUse: { name: "planner_action", input: {} } }]
              }
            }
          });
        }
      }
    }
  );

  await assert.rejects(() => planner.preflight(), /empty or truncated planner_action/);
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
                        actions: [
                          { action: "click", target: { id: "new-routine" }, value: "secret" }
                        ]
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
    /invalid 'click' turn with fields \[actions, reason\][\s\S]*value/
  );
});
