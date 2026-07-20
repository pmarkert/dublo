import { z } from "zod";

const PlannerActionNameSchema = z.enum([
  "click",
  "fill",
  "wait_until_gone",
  "request_user_input",
  "request_user_interaction",
  "request_screenshot",
  "finish"
]);
const WaitUntilGoneExpectationSchema = z
  .object({
    documentText: z.string().trim().min(1)
  })
  .strict();

export const PlannerActionSchema = z
  .object({
    action: PlannerActionNameSchema,
    reason: z.string().trim().min(1),
    targetId: z.string().trim().min(1).optional(),
    value: z.string().optional(),
    expectGone: WaitUntilGoneExpectationSchema.optional(),
    inputKey: z.string().trim().min(1).optional(),
    inputPrompt: z.string().trim().min(1).optional(),
    interactionPrompt: z.string().trim().min(1).optional(),
    screenshotPrompt: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((action, context) => {
    if ((action.action === "click" || action.action === "fill") && !action.targetId) {
      context.addIssue({ code: "custom", message: "click and fill actions require targetId." });
    }
    if (action.action === "fill" && action.value === undefined) {
      context.addIssue({ code: "custom", message: "fill actions require value." });
    }
    if (action.action === "wait_until_gone" && !action.expectGone) {
      context.addIssue({ code: "custom", message: "wait_until_gone requires expectGone." });
    }
    if (action.action === "request_user_input" && (!action.inputKey || !action.inputPrompt)) {
      context.addIssue({
        code: "custom",
        message: "request_user_input requires inputKey and inputPrompt."
      });
    }
    if (action.action === "request_user_interaction" && !action.interactionPrompt) {
      context.addIssue({
        code: "custom",
        message: "request_user_interaction requires interactionPrompt."
      });
    }
    if (action.action === "request_screenshot" && !action.screenshotPrompt) {
      context.addIssue({
        code: "custom",
        message: "request_screenshot requires screenshotPrompt."
      });
    }
  });

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
