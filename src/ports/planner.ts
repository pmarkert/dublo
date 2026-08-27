import { z } from "zod";

const WaitUntilGoneExpectationSchema = z
  .object({
    documentText: z.string().trim().min(1)
  })
  .strict();
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

// A finding is an annotation about the state the planner just observed, not a
// page action: it never touches the DOM and can accompany any action. It lives
// at the turn level (see PlannerTurnSchema) so reporting a defect never
// conflicts with the batching rules and never costs a dedicated turn.
export const FindingSchema = z
  .object({
    severity: z.enum(["info", "minor", "major", "critical"]),
    category: z.enum(["accessibility", "usability", "functional", "performance", "security"]),
    summary: z.string().trim().min(1),
    evidence: z.string().trim().min(1).optional()
  })
  .strict();

const TURN_ACTION_VARIANTS = [
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
  z.object({ action: z.literal("press_key"), key: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("hover"), target: TargetSelectorSchema }).strict(),
  z.object({ action: z.literal("navigate"), url: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("go_back") }).strict(),
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
] as const;

// Actions a planner turn may contain. report_finding is deliberately absent:
// findings are a turn-level annotation, so a "report a finding" state that
// conflicts with batching is unrepresentable rather than merely rejected.
export const TurnActionPayloadSchema = z.discriminatedUnion("action", [...TURN_ACTION_VARIANTS]);

// Legacy payload union that still includes report_finding as an action. Kept
// only so previously recorded blocks and reports (which may contain
// report_finding steps) keep parsing; new planner turns never produce it.
export const PlannerActionPayloadSchema = z.discriminatedUnion("action", [
  ...TURN_ACTION_VARIANTS,
  z
    .object({
      action: z.literal("report_finding"),
      severity: z.enum(["info", "minor", "major", "critical"]),
      category: z.enum(["accessibility", "usability", "functional", "performance", "security"]),
      summary: z.string().trim().min(1),
      evidence: z.string().trim().min(1).optional()
    })
    .strict()
]);

export const PlannerActionSchema = z
  .object({
    reason: z.string().trim().min(1),
    payload: PlannerActionPayloadSchema
  })
  .strict();

// Action types that may follow the first action in a batch. They are local UI
// mutations the runner can re-validate against a fresh observation before each
// one; everything else (navigation, waiting, escalation, termination) must be
// the sole action in the turn.
export const BATCHABLE_ACTIONS = ["click", "fill", "select_option", "hover", "press_key"] as const;
const BATCHABLE_ACTION_SET = new Set<string>(BATCHABLE_ACTIONS);

// A planner turn is one or more actions with no upper bound, plus optional
// findings annotating the state the planner just observed. The first action may
// be any action; any action after it must be batchable, and a non-batchable
// first action must stand alone. Batch size is not capped here: the runner
// re-validates each action, and a batch is limited in practice only by the
// observation's visible-control cap and the model's output-token budget. A run
// may still impose a cap via maxActionsPerTurn.
export const PlannerTurnSchema = z
  .object({
    reason: z.string().trim().min(1),
    findings: z.array(FindingSchema).optional(),
    actions: z.array(TurnActionPayloadSchema).min(1)
  })
  .strict()
  .refine(
    (turn) => {
      const [first, ...rest] = turn.actions;
      if (!first) return false;
      if (rest.length === 0) return true;
      return (
        BATCHABLE_ACTION_SET.has(first.action) &&
        rest.every((action) => BATCHABLE_ACTION_SET.has(action.action))
      );
    },
    {
      message:
        "Only click, fill, select_option, hover, and press_key may be batched; any other action must be the only action in the turn."
    }
  );

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
  action: PlannerTurn;
  tokenUsage: TokenUsage;
}

export interface Planner {
  preflight(signal?: AbortSignal): Promise<void>;
  nextAction(request: PlannerRequest): Promise<PlannerResponse>;
}

// Thrown when a planner responded but the turn failed schema validation — a
// formatting slip by the model, not an API or network failure. The runner
// catches this specifically and retries with the validation message fed back
// (then once more on the escalation model) instead of failing the run.
export class PlannerParseError extends Error {
  readonly validationMessage: string;

  constructor(message: string, validationMessage: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlannerParseError";
    this.validationMessage = validationMessage;
  }
}

export type Finding = z.infer<typeof FindingSchema>;
export type TurnActionPayload = z.infer<typeof TurnActionPayloadSchema>;
export type PlannerActionPayload = z.infer<typeof PlannerActionPayloadSchema>;
export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type PlannerTurn = z.infer<typeof PlannerTurnSchema>;
