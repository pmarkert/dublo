import assert from "node:assert/strict";
import test from "node:test";
import { PlannerTurnSchema } from "../../src/ports/planner.js";

void test("accepts a single non-batchable action", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Objective met.",
    actions: [{ action: "finish" }]
  });
  assert.equal(result.success, true);
});

void test("accepts a batch of batchable actions", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Fill and submit.",
    actions: [
      { action: "fill", target: { label: "Email" }, value: "a@b.co" },
      { action: "fill", target: { label: "Password" }, value: "secret" },
      { action: "click", target: { text: "Sign in" } }
    ]
  });
  assert.equal(result.success, true);
});

void test("drops a non-batchable action after the first, keeping the first", () => {
  // Behaviour change: previously rejected. Keeping only the first action gives
  // the same safety -- no stale follow-on fires against a changed page -- while
  // preserving a run that weaker models would otherwise end routinely.
  const result = PlannerTurnSchema.safeParse({
    reason: "Fill then navigate.",
    actions: [
      { action: "fill", target: { label: "Email" }, value: "a@b.co" },
      { action: "navigate", url: "https://example.test/next" }
    ]
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.actions.length, 1);
  assert.equal(result.data?.actions[0]?.action, "fill");
});

void test("drops extras after a non-batchable primary, keeping the primary", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Finish then click.",
    actions: [{ action: "finish" }, { action: "click", target: { id: "a1" } }]
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.actions.length, 1);
  assert.equal(result.data?.actions[0]?.action, "finish");
});

void test("rejects an empty actions list", () => {
  assert.equal(PlannerTurnSchema.safeParse({ reason: "x", actions: [] }).success, false);
});

void test("accepts an arbitrarily large batch (no upper bound)", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    action: "click" as const,
    target: { id: `a${index}` }
  }));
  assert.equal(PlannerTurnSchema.safeParse({ reason: "x", actions: many }).success, true);
});
