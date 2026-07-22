import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { parsePlannerAction } from "../ports/planner.js";
import type { Planner, PlannerRequest, PlannerResponse, TokenUsage } from "../ports/planner.js";

export interface BedrockPlannerConfig {
  additionalModelRequestFields?: Record<string, unknown>;
  inferenceConfig?: Record<string, unknown>;
  modelId: string;
  region: string;
  serviceTier?: "default" | "priority" | "flex" | "reserved";
  supportsConditionalToolSchemas?: boolean;
  supportsStrictToolUse?: boolean;
}

export interface BedrockClient {
  send(command: ConverseCommand): Promise<unknown>;
}

export interface CreateBedrockPlannerOptions {
  client?: BedrockClient;
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

function assertBedrockConverseResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Bedrock Converse API returned a non-object response.");
  }

  const metadata = isRecord(value.$metadata) ? value.$metadata : undefined;
  const statusCode =
    typeof metadata?.httpStatusCode === "number" && Number.isFinite(metadata.httpStatusCode)
      ? metadata.httpStatusCode
      : undefined;
  const errorCode = typeof value.errorCode === "string" ? value.errorCode : undefined;
  const detail = typeof value.message === "string" ? value.message : undefined;
  const requestId = typeof metadata?.requestId === "string" ? metadata.requestId : undefined;
  if (errorCode || (typeof statusCode === "number" && statusCode >= 400)) {
    throw new Error(
      `Bedrock Converse API returned ${errorCode ?? `HTTP ${statusCode}`}${
        detail ? `: ${detail}` : ""
      }${requestId ? ` (request ID ${requestId})` : ""}.`
    );
  }

  if (!isRecord(value.output)) {
    throw new Error(
      `Bedrock Converse API response did not contain output${
        requestId ? ` (request ID ${requestId})` : ""
      }.`
    );
  }

  return value;
}

function parseBedrockPlannerAction(rawAction: unknown) {
  try {
    return parsePlannerAction(rawAction);
  } catch (error) {
    const action =
      isRecord(rawAction) &&
      isRecord(rawAction.payload) &&
      typeof rawAction.payload.action === "string"
        ? rawAction.payload.action
        : "unknown";
    const fields = isRecord(rawAction) ? Object.keys(rawAction).sort().join(", ") : "non-object";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Bedrock planner returned an invalid '${action}' action with fields [${fields}]: ${detail}`,
      { cause: error }
    );
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTokenUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) return { ...EMPTY_TOKEN_USAGE };
  const inputTokens = numberOrZero(value.inputTokens ?? value.inputTokenCount);
  const outputTokens = numberOrZero(value.outputTokens ?? value.outputTokenCount);
  const totalTokens =
    numberOrZero(value.totalTokens ?? value.totalTokenCount) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens: numberOrZero(
      value.cacheReadInputTokens ?? value.cacheReadInputTokenCount
    ),
    cacheWriteInputTokens: numberOrZero(
      value.cacheWriteInputTokens ?? value.cacheWriteInputTokenCount
    )
  };
}

function extractJsonObject(value: string): unknown {
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(candidate);
}

function serviceTier(config: BedrockPlannerConfig): "priority" | "flex" | "reserved" | undefined {
  return config.serviceTier === "priority" ||
    config.serviceTier === "flex" ||
    config.serviceTier === "reserved"
    ? config.serviceTier
    : undefined;
}

function buildTargetSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  };
}

function buildActionPayloadVariant(
  action: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", ...required],
    properties: {
      action: { const: action },
      ...properties
    }
  };
}

function buildActionSchema(): Record<string, unknown> {
  const target = buildTargetSchema();
  const expectGone = {
    type: "object",
    additionalProperties: false,
    required: ["documentText"],
    properties: { documentText: { type: "string" } }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["reason", "payload"],
    properties: {
      reason: { type: "string" },
      payload: {
        anyOf: [
          buildActionPayloadVariant("click", { target }, ["target"]),
          buildActionPayloadVariant("fill", { target, value: { type: "string" } }, [
            "target",
            "value"
          ]),
          buildActionPayloadVariant("select_option", { target, value: { type: "string" } }, [
            "target",
            "value"
          ]),
          buildActionPayloadVariant(
            "scroll",
            { containerId: { type: "string" }, direction: { enum: ["up", "down"] } },
            ["containerId", "direction"]
          ),
          buildActionPayloadVariant("wait_until_gone", { expectGone }, ["expectGone"]),
          buildActionPayloadVariant(
            "request_user_input",
            { inputKey: { type: "string" }, inputPrompt: { type: "string" } },
            ["inputKey", "inputPrompt"]
          ),
          buildActionPayloadVariant(
            "request_user_interaction",
            { interactionPrompt: { type: "string" } },
            ["interactionPrompt"]
          ),
          buildActionPayloadVariant(
            "request_screenshot",
            { screenshotPrompt: { type: "string" } },
            ["screenshotPrompt"]
          ),
          buildActionPayloadVariant("give_up"),
          buildActionPayloadVariant("finish")
        ]
      }
    }
  };
}

function buildToolConfig(config: BedrockPlannerConfig): Record<string, unknown> {
  if (config.supportsStrictToolUse) {
    return {
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "planner_action",
              description: "Return the next UI automation action as structured JSON input.",
              strict: true,
              inputSchema: { json: buildActionSchema() }
            }
          }
        ],
        toolChoice: { tool: { name: "planner_action" } }
      }
    };
  }

  return {
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: "planner_action",
            description: "Return the next UI automation action as structured JSON input.",
            inputSchema: { json: buildActionSchema() }
          }
        }
      ],
      toolChoice: { tool: { name: "planner_action" } }
    }
  };
}

function buildInferenceConfig(
  config: BedrockPlannerConfig,
  maxTokens: number
): Record<string, unknown> {
  return { maxTokens, ...(config.inferenceConfig ?? {}) };
}

function buildRequest(
  config: BedrockPlannerConfig,
  input: Record<string, unknown>,
  includeServiceTier: boolean
): ConverseCommand {
  const tier = includeServiceTier ? serviceTier(config) : undefined;
  return new ConverseCommand({
    modelId: config.modelId,
    ...(tier ? { serviceTier: tier } : {}),
    ...input
  } as unknown as ConverseCommandInput);
}

async function sendWithServiceTierFallback(
  client: BedrockClient,
  config: BedrockPlannerConfig,
  input: Record<string, unknown>
): Promise<unknown> {
  try {
    return await client.send(buildRequest(config, input, true));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (serviceTier(config) && /unexpected field type/i.test(detail)) {
      return client.send(buildRequest(config, input, false));
    }
    throw error;
  }
}

export function createBedrockPlanner(
  config: BedrockPlannerConfig,
  options: CreateBedrockPlannerOptions = {}
): Planner {
  const client = options.client ?? new BedrockRuntimeClient({ region: config.region });

  return {
    async preflight() {
      try {
        const result = await sendWithServiceTierFallback(client, config, {
          messages: [
            {
              role: "user",
              content: [
                {
                  text: "Call the planner_action tool with reason 'Preflight.' and payload action 'finish'."
                }
              ]
            }
          ],
          inferenceConfig: buildInferenceConfig(config, 20),
          ...(config.additionalModelRequestFields
            ? { additionalModelRequestFields: config.additionalModelRequestFields }
            : {}),
          ...buildToolConfig(config)
        });
        assertBedrockConverseResponse(result);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Bedrock preflight failed for model '${config.modelId}'. Check AWS credentials, region, and model access. Detail: ${detail}`,
          { cause: error }
        );
      }
    },

    async nextAction(request: PlannerRequest): Promise<PlannerResponse> {
      const content: Array<Record<string, unknown>> = [
        { text: request.messages.staticContextText }
      ];
      content.push({ text: request.messages.dynamicContextText });
      if (request.screenshot) {
        content.push({ image: { format: "png", source: { bytes: request.screenshot } } });
      }

      const result = assertBedrockConverseResponse(
        await sendWithServiceTierFallback(client, config, {
          system: [{ text: request.messages.systemText }],
          messages: [{ role: "user", content }],
          inferenceConfig: buildInferenceConfig(config, 700),
          ...(config.additionalModelRequestFields
            ? { additionalModelRequestFields: config.additionalModelRequestFields }
            : {}),
          ...buildToolConfig(config)
        })
      );
      const output = isRecord(result.output) ? result.output : undefined;
      const message = output && isRecord(output.message) ? output.message : undefined;
      const contentItems = Array.isArray(message?.content) ? message.content : [];
      const toolItem = contentItems.find(
        (item): item is Record<string, unknown> => isRecord(item) && isRecord(item.toolUse)
      );
      const toolUse = toolItem && isRecord(toolItem.toolUse) ? toolItem.toolUse : undefined;
      const rawAction = toolUse?.input;
      if (rawAction === undefined) {
        const text = contentItems
          .filter(isRecord)
          .map((item) => (typeof item.text === "string" ? item.text : ""))
          .join("\n")
          .trim();
        if (!text) throw new Error("Bedrock planner API returned no planner action.");
        return {
          action: parseBedrockPlannerAction(extractJsonObject(text)),
          tokenUsage: normalizeTokenUsage(result.usage)
        };
      }
      return {
        action: parseBedrockPlannerAction(rawAction),
        tokenUsage: normalizeTokenUsage(result.usage)
      };
    }
  };
}
