import { Buffer } from "node:buffer";
import { parsePlannerAction } from "../ports/planner.js";
import type { Planner, PlannerRequest, PlannerResponse, TokenUsage } from "../ports/planner.js";

export interface OpenAICompatiblePlannerConfig {
  apiKey?: string;
  baseUrl: string;
  modelId: string;
}

export interface CreateOpenAICompatiblePlannerOptions {
  fetch?: typeof fetch;
}

const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTokenUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) return { ...EMPTY_TOKEN_USAGE };
  const inputTokens = numberOrZero(value.prompt_tokens ?? value.inputTokens);
  const outputTokens = numberOrZero(value.completion_tokens ?? value.outputTokens);
  const totalTokens =
    numberOrZero(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
  return { ...EMPTY_TOKEN_USAGE, inputTokens, outputTokens, totalTokens };
}

function extractJsonObject(value: string): unknown {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) return JSON.parse(trimmed.slice(start, index + 1));
      }
    }
    throw new Error("Planner response did not contain a JSON object.");
  }
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function getChatCompletionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildPlannerActionSchema(): Record<string, unknown> {
  const target = {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  };
  const variant = (
    action: string,
    properties: Record<string, unknown> = {},
    required: string[] = []
  ) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", ...required],
    properties: { action: { const: action }, ...properties }
  });

  return {
    type: "object",
    additionalProperties: false,
    required: ["reason", "payload"],
    properties: {
      reason: { type: "string" },
      payload: {
        anyOf: [
          variant("click", { target }, ["target"]),
          variant("fill", { target, value: { type: "string" } }, ["target", "value"]),
          variant("select_option", { target, value: { type: "string" } }, ["target", "value"]),
          variant(
            "scroll",
            { containerId: { type: "string" }, direction: { enum: ["up", "down"] } },
            ["containerId", "direction"]
          ),
          variant(
            "wait_until_gone",
            {
              expectGone: {
                type: "object",
                additionalProperties: false,
                required: ["documentText"],
                properties: { documentText: { type: "string" } }
              }
            },
            ["expectGone"]
          ),
          variant(
            "request_user_input",
            { inputKey: { type: "string" }, inputPrompt: { type: "string" } },
            ["inputKey", "inputPrompt"]
          ),
          variant("request_user_interaction", { interactionPrompt: { type: "string" } }, [
            "interactionPrompt"
          ]),
          variant("request_screenshot", { screenshotPrompt: { type: "string" } }, [
            "screenshotPrompt"
          ]),
          variant("give_up"),
          variant("finish")
        ]
      }
    }
  };
}

export function createOpenAICompatiblePlanner(
  config: OpenAICompatiblePlannerConfig,
  options: CreateOpenAICompatiblePlannerOptions = {}
): Planner {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = getChatCompletionUrl(config.baseUrl);

  return {
    async preflight(signal) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: buildHeaders(config.apiKey),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          model: config.modelId,
          messages: [{ role: "user", content: 'Return exactly this JSON: {"ok":true}' }],
          max_tokens: 20
        })
      });
      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible preflight failed for model '${config.modelId}' at '${config.baseUrl}': ${await readErrorBody(response)}`
        );
      }
    },

    async nextAction(request: PlannerRequest): Promise<PlannerResponse> {
      const userContent: Array<Record<string, unknown>> = [
        { type: "text", text: request.messages.staticContextText },
        { type: "text", text: request.messages.dynamicContextText }
      ];
      if (request.screenshot) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(request.screenshot).toString("base64")}`
          }
        });
      }

      const response = await fetchImpl(url, {
        method: "POST",
        headers: buildHeaders(config.apiKey),
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          model: config.modelId,
          messages: [
            { role: "system", content: request.messages.systemText },
            { role: "user", content: userContent }
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "planner_action",
                description: "Return the next UI automation action as structured JSON input.",
                parameters: buildPlannerActionSchema()
              }
            }
          ],
          tool_choice: { type: "function", function: { name: "planner_action" } },
          max_tokens: 700
        })
      });
      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible planner call failed for model '${config.modelId}' at '${config.baseUrl}': ${await readErrorBody(response)}`
        );
      }

      const result: unknown = await response.json();
      if (!isRecord(result))
        throw new Error("OpenAI-compatible planner response was not a JSON object.");
      const choices = result.choices;
      const firstChoice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
      const message =
        firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
      const toolCalls = message?.tool_calls;
      const firstToolCall =
        Array.isArray(toolCalls) && isRecord(toolCalls[0]) ? toolCalls[0] : undefined;
      const toolFunction =
        firstToolCall && isRecord(firstToolCall.function) ? firstToolCall.function : undefined;
      const argumentsText = toolFunction?.arguments;
      const content = message?.content;
      const rawAction =
        typeof argumentsText === "string"
          ? extractJsonObject(argumentsText)
          : typeof content === "string"
            ? extractJsonObject(content)
            : undefined;
      if (rawAction === undefined)
        throw new Error("OpenAI-compatible planner API returned no planner action.");

      return {
        action: parsePlannerAction(rawAction),
        tokenUsage: normalizeTokenUsage(result.usage)
      };
    }
  };
}
