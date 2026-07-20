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
                      input: { action: "finish", reason: "Success criteria are visible." }
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

  assert.deepEqual(response.action, { action: "finish", reason: "Success criteria are visible." });
  assert.deepEqual(response.tokenUsage, {
    inputTokens: 8,
    outputTokens: 3,
    totalTokens: 11,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0
  });
  assert.equal(requests.length, 1);
});
