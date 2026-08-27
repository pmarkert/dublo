import assert from "node:assert/strict";
import test from "node:test";
import { PlannerActionSchema, PlannerTurnSchema } from "../../src/ports/planner.js";

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

void test("accepts findings as a turn-level annotation on any action", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Record the defect and keep filling the form.",
    findings: [
      {
        severity: "major",
        category: "accessibility",
        summary: "Icon-only button has no accessible name.",
        evidence: "Control a7 has no label, aria-label, or text."
      }
    ],
    actions: [
      { action: "fill", target: { label: "Email" }, value: "a@b.co" },
      { action: "click", target: { text: "Next" } }
    ]
  });
  assert.equal(result.success, true);
});

void test("rejects report_finding as a turn action (findings are turn-level now)", () => {
  const result = PlannerTurnSchema.safeParse({
    reason: "Report the defect.",
    actions: [
      {
        action: "report_finding",
        severity: "major",
        category: "accessibility",
        summary: "Icon-only button has no accessible name."
      }
    ]
  });
  assert.equal(result.success, false);
});

void test("legacy PlannerActionSchema still parses recorded report_finding steps", () => {
  const result = PlannerActionSchema.safeParse({
    reason: "Recorded in an older run.",
    payload: {
      action: "report_finding",
      severity: "minor",
      category: "usability",
      summary: "Save button is easy to miss."
    }
  });
  assert.equal(result.success, true);
});
