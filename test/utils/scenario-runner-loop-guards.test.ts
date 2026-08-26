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

void test("a registered secret outranks human escalation for OTP codes", async () => {
  const { buildPlannerMessages } = await import("../../src/utils/scenario/planner-context.mjs");

  const build = (secretValues: Map<string, string>) =>
    buildPlannerMessages({
      testPrompt: "Sign in.",
      personaText: "",
      workspacePromptText: "",
      contextData: {},
      secretValues,
      observation: {
        url: "https://example.test",
        title: "Sign in",
        modal: {},
        headings: [],
        alerts: [],
        documentText: "",
        controls: []
      },
      actionHistory: [],
      humanInputs: new Map(),
      screenshotRequested: false
    });

  const withSecret = build(new Map([["auth.otpCode", "123456"]]));
  const withoutSecret = build(new Map());

  // Naming OTP codes as the request_user_input example sends the planner to a
  // human even when the code was registered as a secret, which makes an OTP
  // sign-in unrunnable headless and a pinned non-production code pointless.
  assert.match(withSecret.staticContextText, /check availableSecretPaths/i);
  assert.match(withSecret.staticContextText, /OTP or sign-in code included/i);

  // Without a registered secret the plain escalation guidance still stands.
  assert.doesNotMatch(withoutSecret.staticContextText, /check availableSecretPaths/i);
  assert.match(withoutSecret.staticContextText, /request_user_input/i);
});

void test("progress key ignores actions and tracks what is on screen", async () => {
  const { progressKey } = await import("../../src/utils/scenario-runner.mjs");
  const screen = (url: string, text: string, ids: string[]) =>
    progressKey(url, { documentText: text, controls: ids.map((id) => ({ id })) });

  // Same screen, regardless of what was attempted on it.
  assert.equal(screen("/login", "Check your email", ["a1", "a2"]), screen("/login", "Check your email", ["a1", "a2"]));

  // Any of the three dimensions changing counts as progress.
  assert.notEqual(screen("/login", "Check your email", ["a1"]), screen("/myday", "Check your email", ["a1"]));
  assert.notEqual(screen("/login", "Check your email", ["a1"]), screen("/login", "Invalid or expired code", ["a1"]));
  assert.notEqual(screen("/login", "Check your email", ["a1"]), screen("/login", "Check your email", ["a1", "a2"]));
});

void test("progress key tolerates a missing or malformed observation", async () => {
  const { progressKey } = await import("../../src/utils/scenario-runner.mjs");
  assert.equal(typeof progressKey("/x", undefined), "string");
  assert.equal(typeof progressKey("/x", {}), "string");
  assert.equal(typeof progressKey("/x", { controls: [{}, null] }), "string");
});
