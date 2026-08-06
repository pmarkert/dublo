import { z } from "zod";

const ObservedNodeSelectorSchema = z
  .object({
    kind: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    ariaLabel: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    checked: z.boolean().optional(),
    selected: z.boolean().optional(),
    pressed: z.boolean().optional(),
    expanded: z.boolean().optional(),
    disabled: z.boolean().optional(),
    blocking: z.boolean().optional()
  })
  .strict()
  .refine((selector) => Object.keys(selector).length > 0, {
    message: "expected node selector must contain at least one node property."
  });
const WaitUntilGoneExpectationSchema = z.array(ObservedNodeSelectorSchema).min(1);
const TargetSelectorSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    role: z.string().optional(),
    type: z.string().optional(),
    priority: z.boolean().optional(),
    text: z.string().optional(),
    ariaLabel: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    hasValue: z.boolean().optional(),
    checked: z.boolean().optional(),
    disabled: z.boolean().optional()
  })
  .strict()
  .refine((target) => Object.keys(target).length > 0, {
    message: "target must contain at least one control property."
  });

export const PlannerActionPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), target: TargetSelectorSchema }).strict(),
  z.object({ action: z.literal("fill"), target: TargetSelectorSchema, value: z.string() }).strict(),
  z
    .object({ action: z.literal("select_option"), target: TargetSelectorSchema, value: z.string() })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      containerId: z.string().trim().min(1),
      direction: z.enum(["up", "down"])
    })
    .strict(),
  z
    .object({ action: z.literal("wait_until_gone"), expectGone: WaitUntilGoneExpectationSchema })
    .strict(),
  z
    .object({
      action: z.literal("request_user_input"),
      inputKey: z.string().trim().min(1),
      inputPrompt: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      action: z.literal("request_user_interaction"),
      interactionPrompt: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({ action: z.literal("request_screenshot"), screenshotPrompt: z.string().trim().min(1) })
    .strict(),
  z.object({ action: z.literal("give_up") }).strict(),
  z.object({ action: z.literal("finish") }).strict()
]);

export const PlannerAssertionSchema = z
  .object({
    subject: z.string().trim().min(1).max(80),
    observed: z.string().trim().min(1).max(240),
    status: z.enum(["confirmed", "contradicts_objective", "unknown"]),
    durability: z.enum(["current_view", "persisted"])
  })
  .strict();

export const PlannerActionSchema = z
  .object({
    reason: z.string().trim().min(1),
    assertions: z.array(PlannerAssertionSchema).max(3).optional(),
    payload: PlannerActionPayloadSchema
  })
  .strict();

export function parsePlannerAction(value: unknown) {
  const action = PlannerActionSchema.parse(value);
  if (!("target" in action.payload)) return action;

  const { id } = action.payload.target;
  if (!id) {
    throw new Error("Planner target must include an observed control ID.");
  }

  return {
    ...action,
    payload: { ...action.payload, target: { id } }
  };
}

export interface PlannerMessages {
  systemText: string;
  staticContextText: string;
  dynamicContextText: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export class PlannerResponseValidationError extends Error {
  readonly plannerResponse: unknown;
  readonly tokenUsage: TokenUsage;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      plannerResponse: unknown;
      tokenUsage: TokenUsage;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "PlannerResponseValidationError";
    this.plannerResponse = options.plannerResponse;
    this.tokenUsage = options.tokenUsage;
  }
}

export interface PlannerRequest {
  messages: PlannerMessages;
  screenshot?: Uint8Array;
  signal?: AbortSignal;
}

export interface PlannerResponse {
  action: PlannerAction;
  tokenUsage: TokenUsage;
}

export interface Planner {
  preflight(signal?: AbortSignal): Promise<void>;
  nextAction(request: PlannerRequest): Promise<PlannerResponse>;
}

export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type PlannerAssertion = z.infer<typeof PlannerAssertionSchema>;
