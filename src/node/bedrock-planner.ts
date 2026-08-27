import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { PlannerParseError, PlannerTurnSchema } from "../ports/planner.js";
import type { Planner, PlannerRequest, PlannerResponse, TokenUsage } from "../ports/planner.js";

export interface BedrockPlannerConfig {
  additionalModelRequestFields?: Record<string, unknown>;
  inferenceConfig?: Record<string, unknown>;
  modelId: string;
  region: string;
  promptCaching?: boolean;
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

function parsePlannerAction(rawAction: unknown) {
  try {
    return PlannerTurnSchema.parse(rawAction);
  } catch (error) {
    const firstAction =
      isRecord(rawAction) && Array.isArray(rawAction.actions) && isRecord(rawAction.actions[0])
        ? rawAction.actions[0]
        : undefined;
    const action = typeof firstAction?.action === "string" ? firstAction.action : "unknown";
    const fields = isRecord(rawAction) ? Object.keys(rawAction).sort().join(", ") : "non-object";
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerParseError(
      `Bedrock planner returned an invalid '${action}' turn with fields [${fields}]: ${detail}`,
      detail,
      { cause: error }
    );
  }
}

// Pulls the planner_action payload out of a Converse response. Prefers the
// forced toolUse.input; falls back to a JSON object embedded in a text block
// (some models emit the call as text). Returns undefined when neither is
// present. A truncated tool call surfaces here as an empty `{}` input.
function extractPlannerActionInput(result: Record<string, unknown>): unknown {
  const output = isRecord(result.output) ? result.output : undefined;
  const message = output && isRecord(output.message) ? output.message : undefined;
  const contentItems = Array.isArray(message?.content) ? message.content : [];
  const toolItem = contentItems.find(
    (item): item is Record<string, unknown> => isRecord(item) && isRecord(item.toolUse)
  );
  const toolUse = toolItem && isRecord(toolItem.toolUse) ? toolItem.toolUse : undefined;
  if (toolUse?.input !== undefined) return toolUse.input;
  const text = contentItems
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n")
    .trim();
  if (!text) return undefined;
  return extractJsonObject(text);
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

function buildTargetSchema(strict: boolean): Record<string, unknown> {
  if (strict) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } }
    };
  }

  const fallbackNote =
    "Fallback only; fields are ANDed with id, so a guessed value makes the match fail.";
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description:
          "Preferred and sufficient on its own: the control id from the current observation (e.g. 'a3'). Ids are unique per observation."
      },
      tag: { type: "string", description: fallbackNote },
      role: { type: "string", description: fallbackNote },
      type: { type: "string", description: fallbackNote },
      priority: { type: "boolean", description: fallbackNote },
      text: { type: "string", description: fallbackNote },
      ariaLabel: { type: "string", description: fallbackNote },
      label: { type: "string", description: fallbackNote },
      placeholder: { type: "string", description: fallbackNote },
      hasValue: { type: "boolean", description: fallbackNote },
      checked: { type: "boolean", description: fallbackNote },
      disabled: { type: "boolean", description: fallbackNote }
    }
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

function buildActionSchema(strict: boolean): Record<string, unknown> {
  const target = buildTargetSchema(strict);
  const expectGone = {
    type: "object",
    additionalProperties: false,
    required: ["documentText"],
    properties: { documentText: { type: "string" } }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["reason", "actions"],
    properties: {
      reason: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "category", "summary"],
          properties: {
            severity: { enum: ["info", "minor", "major", "critical"] },
            category: {
              enum: ["accessibility", "usability", "functional", "performance", "security"]
            },
            summary: { type: "string" },
            evidence: { type: "string" }
          }
        }
      },
      actions: {
        type: "array",
        minItems: 1,
        items: {
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
            buildActionPayloadVariant("press_key", { key: { type: "string" } }, ["key"]),
            buildActionPayloadVariant("hover", { target }, ["target"]),
            buildActionPayloadVariant("navigate", { url: { type: "string" } }, ["url"]),
            buildActionPayloadVariant("go_back"),
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
              description:
                "Return the next UI automation action, or a short batch of actions, as structured JSON input.",
              strict: true,
              inputSchema: { json: buildActionSchema(true) }
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
            description:
              "Return the next UI automation action, or a short batch of actions, as structured JSON input.",
            inputSchema: { json: buildActionSchema(false) }
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
                  text: "Call the planner_action tool with reason 'Preflight.' and actions set to a single entry with action 'finish'."
                }
              ]
            }
          ],
          // The forced planner_action tool call returns { reason, actions: [...] },
          // which needs ~40-50 output tokens. A tighter cap truncates the tool
          // use mid-sequence: Anthropic models return an empty toolUse that still
          // passes the shape check, but Nova rejects the invalid sequence
          // ("Model produced invalid sequence as part of ToolUse"). Give the
          // preflight room to emit the whole (tiny) call.
          inferenceConfig: buildInferenceConfig(config, 256),
          ...(config.additionalModelRequestFields
            ? { additionalModelRequestFields: config.additionalModelRequestFields }
            : {}),
          ...buildToolConfig(config)
        });
        // Verify the model produced a complete, well-formed planner_action —
        // not just a syntactically valid envelope. A too-tight token budget
        // truncates the toolUse: some endpoints reject it outright, others
        // return an empty `{}` input that would pass a shape-only check. Parse
        // the payload so a truncated or malformed call fails loudly here rather
        // than sorting working models into pass/fail on an unrelated signal.
        const rawAction = extractPlannerActionInput(assertBedrockConverseResponse(result));
        if (!isRecord(rawAction) || Object.keys(rawAction).length === 0) {
          throw new Error(
            "the model returned an empty or truncated planner_action tool call (no input fields). This usually means the output token budget is too small."
          );
        }
        parsePlannerAction(rawAction);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Bedrock preflight failed for model '${config.modelId}'. Check AWS credentials, region, and model access. Detail: ${detail}`,
          { cause: error }
        );
      }
    },

    async nextAction(request: PlannerRequest): Promise<PlannerResponse> {
      // Cache the large, run-stable prefix (system prompt + static context) so
      // each step reads it from cache instead of re-billing it at the full input
      // rate. The dynamic context (observation, history) follows the cache point
      // and changes every turn. Below-threshold prefixes are ignored by Bedrock,
      // so enabling this is safe on supported models.
      const cachePoint = { cachePoint: { type: "default" } };
      const system: Array<Record<string, unknown>> = [{ text: request.messages.systemText }];
      if (config.promptCaching) {
        system.push({ ...cachePoint });
      }

      const content: Array<Record<string, unknown>> = [
        { text: request.messages.staticContextText }
      ];
      if (config.promptCaching) {
        content.push({ ...cachePoint });
      }
      content.push({ text: request.messages.dynamicContextText });
      if (request.screenshot) {
        content.push({ image: { format: "png", source: { bytes: request.screenshot } } });
      }

      const result = assertBedrockConverseResponse(
        await sendWithServiceTierFallback(client, config, {
          system,
          messages: [{ role: "user", content }],
          inferenceConfig: buildInferenceConfig(config, 4096),
          ...(config.additionalModelRequestFields
            ? { additionalModelRequestFields: config.additionalModelRequestFields }
            : {}),
          ...buildToolConfig(config)
        })
      );
      const rawAction = extractPlannerActionInput(result);
      if (rawAction === undefined) {
        throw new Error("Bedrock planner API returned no planner action.");
      }
      return {
        action: parsePlannerAction(rawAction),
        tokenUsage: normalizeTokenUsage(result.usage)
      };
    }
  };
}
