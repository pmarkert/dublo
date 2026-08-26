import assert from "node:assert/strict";
import test from "node:test";
import { PlannerTurnSchema, MAX_ACTIONS_PER_TURN } from "../../src/ports/planner.js";

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

void test("rejects a non-batchable action after the first", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Fill then navigate.",
    actions: [
      { action: "fill", target: { label: "Email" }, value: "a@b.co" },
      { action: "navigate", url: "https://example.test/next" }
    ]
  });
  assert.equal(result.success, false);
});

void test("rejects a non-batchable primary paired with extra actions", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Finish then click.",
    actions: [{ action: "finish" }, { action: "click", target: { id: "a1" } }]
  });
  assert.equal(result.success, false);
});

void test("rejects an empty or over-long actions list", () => {
  assert.equal(PlannerTurnSchema.safeParse({ reason: "x", actions: [] }).success, false);
  const tooMany = Array.from({ length: MAX_ACTIONS_PER_TURN + 1 }, () => ({
    action: "click" as const,
    target: { id: "a1" }
  }));
  assert.equal(PlannerTurnSchema.safeParse({ reason: "x", actions: tooMany }).success, false);
});
