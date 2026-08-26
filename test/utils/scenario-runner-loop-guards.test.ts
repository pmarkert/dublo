import assert from "node:assert/strict";
import test from "node:test";
import { actionSignature, trailingFailureRepeats } from "../../src/utils/scenario-runner.mjs";

const fill = (id: string, value = "x") => ({
  reason: "",
  payload: { action: "fill", target: { id, label: "Verification code" }, value }
});

void test("action signature ignores the filled value but not the target", () => {
  // The value is irrelevant to whether the attempt can succeed: when the target
  // cannot be resolved, a different value is the same doomed action.
  assert.equal(actionSignature(fill("a2", "111111")), actionSignature(fill("a2", "222222")));
  assert.notEqual(actionSignature(fill("a2")), actionSignature(fill("a7")));
});

void test("action signature distinguishes different actions on the same target", () => {
  const click = { reason: "", payload: { action: "click", target: { id: "a2" } } };
  assert.notEqual(actionSignature(fill("a2")), actionSignature(click));
});

void test("action signature tolerates malformed planner actions", () => {
  assert.equal(typeof actionSignature(undefined), "string");
  assert.equal(typeof actionSignature({}), "string");
});

void test("counts only the unbroken tail of identical failures", () => {
  const signature = actionSignature(fill("a2"));
  const history = [
    { action: fill("a2"), outcome: "target_disappeared" },
    { action: fill("a2"), outcome: "target_disappeared" },
    { action: fill("a2"), outcome: "target_disappeared" }
  ];
  assert.equal(trailingFailureRepeats(history, signature), 3);
});

void test("a success resets the streak", () => {
  const signature = actionSignature(fill("a2"));
  const history = [
    { action: fill("a2"), outcome: "target_disappeared" },
    { action: fill("a2"), outcome: "ok" },
    { action: fill("a2"), outcome: "target_disappeared" }
  ];
  // An action that failed, succeeded, then failed again is not a stuck planner.
  assert.equal(trailingFailureRepeats(history, signature), 1);
});

void test("a different failing action resets the streak", () => {
  const signature = actionSignature(fill("a2"));
  const history = [
    { action: fill("a2"), outcome: "target_disappeared" },
    { action: fill("a9"), outcome: "target_disappeared" },
    { action: fill("a2"), outcome: "target_disappeared" }
  ];
  assert.equal(trailingFailureRepeats(history, signature), 1);
});

void test("an empty history has no streak", () => {
  assert.equal(trailingFailureRepeats([], actionSignature(fill("a2"))), 0);
});

void test("the observed 40-attempt loop trips the default threshold of 3", () => {
  // Regression guard for the run that spent 40 of 80 steps on one unresolvable
  // target. The breaker must fire on the third attempt, not the fortieth.
  const signature = actionSignature(fill("a2"));
  const history = Array.from({ length: 40 }, () => ({
    action: fill("a2"),
    outcome: "target_disappeared"
  }));
  assert.ok(trailingFailureRepeats(history.slice(0, 3), signature) >= 3);
});
