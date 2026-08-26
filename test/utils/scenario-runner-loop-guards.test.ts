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

void test("a resolving id wins over abbreviated descriptive fields", async () => {
  const { resolveTargetControl } = await import("../../src/utils/scenario-runner.mjs");
  const controls = [
    { id: "a17", text: "Account Manage your name, picture, and care network." },
    { id: "a20", text: "Family Accounts Manage dependent accounts for family members" }
  ];

  // Models abbreviate the text they saw. The id already pins the element, so a
  // partial text should not turn into "target not found" -- which tells the
  // planner the element vanished and invites a retry against an unchanged page.
  // resolveTargetControl comes from an untyped .mjs, so name the shape we assert on.
  const hit = resolveTargetControl(controls, { id: "a17", text: "Account" }) as { id: string };
  assert.equal(hit.id, "a17");

  // An exact match still works, and an id that matches nothing still throws.
  assert.equal((resolveTargetControl(controls, { id: "a20" }) as { id: string }).id, "a20");
  assert.throws(() => resolveTargetControl(controls, { id: "a99" }), /not found/);
});

void test("required paths come from an explicit list or a pointer into context", async () => {
  const { requiredVisitedPaths } = await import("../../src/utils/scenario-runner.mjs");

  assert.deepEqual(requiredVisitedPaths({ finish: { requireVisited: ["/a", "/b"] } }), ["/a", "/b"]);

  // A pointer lets a sweep reuse the inventory it was already given, rather than
  // restating thirty paths that would then drift.
  const ctx = { routes: { app: ["/x", "/y"] }, finish: { requireVisitedFrom: "routes.app" } };
  assert.deepEqual(requiredVisitedPaths(ctx), ["/x", "/y"]);

  // Absent, malformed, or dangling config means no gate — never a crash.
  assert.deepEqual(requiredVisitedPaths({}), []);
  assert.deepEqual(requiredVisitedPaths(undefined), []);
  assert.deepEqual(requiredVisitedPaths({ finish: { requireVisitedFrom: "nope.missing" } }), []);
  assert.deepEqual(requiredVisitedPaths({ finish: { requireVisited: "not-an-array" } }), []);
});

void test("path comparison ignores origin and query", async () => {
  const { pathOf } = await import("../../src/utils/scenario-runner.mjs");
  assert.equal(pathOf("http://localhost:8080/settings/account"), "/settings/account");
  assert.equal(pathOf("http://localhost:8080/myday?view=timeline"), "/myday");
  assert.equal(pathOf("http://localhost:8080"), "/");
  assert.equal(pathOf("not a url"), "not a url");
});

void test("outcome classification distinguishes why a run ended", async () => {
  const { classifyOutcome } = await import("../../src/utils/scenario-runner.mjs");
  const base = { metCriteria: 2, recoverableFailures: 0 };

  // Friction, not budget: the step ceiling is a guess, so grading against it would
  // score identical work differently depending on the number the scenario carries.
  assert.equal(classifyOutcome({ ...base, status: "passed" }), "completed");
  assert.equal(
    classifyOutcome({ ...base, status: "passed", recoverableFailures: 7 }),
    "completed-with-friction"
  );
  // A generous budget must not change the verdict for the same work.
  assert.equal(classifyOutcome({ ...base, status: "passed", recoverableFailures: 1 }), "completed");

  // Moving without arriving is a path problem; jammed on one control is not.
  assert.equal(
    classifyOutcome({ ...base, status: "failed", error: "Aborted after 15 turns without meeting a new success criterion" }),
    "lost"
  );
  assert.equal(
    classifyOutcome({ ...base, status: "failed", error: "Aborted after 8 consecutive turns with no visible change" }),
    "stuck"
  );
  assert.equal(
    classifyOutcome({ ...base, status: "failed", error: "Aborted after the same action failed 3 times in a row" }),
    "blocked"
  );

  // Out of budget while still meeting criteria means the budget was wrong, not the app.
  assert.equal(
    classifyOutcome({ ...base, status: "failed", error: "Max steps reached (100) before objective completion." }),
    "budget-exhausted"
  );
  assert.equal(
    classifyOutcome({ ...base, status: "failed", error: "Max steps reached (100)", metCriteria: 0 }),
    "lost"
  );
});

void test("step drift is measured against a baseline, not a budget", async () => {
  const { classifyOutcome, expectedStepsFrom } = await import("../../src/utils/scenario-runner.mjs");

  assert.equal(expectedStepsFrom({ finish: { expectedSteps: 45 } }), 45);
  assert.equal(expectedStepsFrom({ finish: {} }), 0);
  assert.equal(expectedStepsFrom({ finish: { expectedSteps: "45" } }), 0);
  assert.equal(expectedStepsFrom(undefined), 0);

  const pass = { status: "passed", metCriteria: 3, recoverableFailures: 0 };

  // Within tolerance, and comfortably over it.
  assert.equal(classifyOutcome({ ...pass, stepsUsed: 50, expectedSteps: 45 }), "completed");
  assert.equal(
    classifyOutcome({ ...pass, stepsUsed: 70, expectedSteps: 45 }),
    "completed-slower-than-expected"
  );

  // No baseline declared means no drift verdict — silence, not a guess.
  assert.equal(classifyOutcome({ ...pass, stepsUsed: 500, expectedSteps: 0 }), "completed");

  // Friction is the more actionable finding when both apply.
  assert.equal(
    classifyOutcome({ ...pass, recoverableFailures: 9, stepsUsed: 70, expectedSteps: 45 }),
    "completed-with-friction"
  );
});

void test("a harness failure is never reported as an app defect", async () => {
  const { classifyOutcome } = await import("../../src/utils/scenario-runner.mjs");
  const failed = { status: "failed", metCriteria: 0, recoverableFailures: 2 };

  // Each of these is the tool failing, not the product. Falling through to
  // "blocked" would send someone hunting a bug that does not exist.
  for (const error of [
    "Bedrock planner API returned no planner action.",
    "Model produced invalid sequence as part of ToolUse.",
    "Bedrock preflight failed for model 'x'.",
    "Bedrock planner returned an invalid 'finish' turn with fields [actions, reason]"
  ]) {
    assert.equal(classifyOutcome({ ...failed, error }), "tooling-error");
  }

  // A genuine repeated-action failure still reads as blocked.
  assert.equal(
    classifyOutcome({ ...failed, error: "Aborted after the same action failed 3 times in a row" }),
    "blocked"
  );
});

void test("absence of a progress signal is not evidence of being lost", async () => {
  const { classifyOutcome } = await import("../../src/utils/scenario-runner.mjs");
  // The guard that produces this error only fires once criteriaMet has been used
  // at least once; a planner that never reports it must not be judged lost. This
  // asserts the classification stays honest about which signal it acted on.
  assert.equal(
    classifyOutcome({
      status: "failed",
      error: "Aborted after 15 turns without meeting a new success criterion, across 9 screen changes.",
      metCriteria: 3,
      recoverableFailures: 0
    }),
    "lost"
  );
});

void test("a stale id does not override a descriptor that contradicts it", async () => {
  const { resolveTargetControl } = await import("../../src/utils/scenario-runner.mjs");
  const controls = [
    { id: "a3", tag: "button", label: "Continue with email" },
    { id: "a7", tag: "input", label: "Email address" }
  ];

  // A replayed block records ids that later belong to other elements. Trusting the
  // id here filled a button that had inherited the id recorded for an email field.
  // Refusing is the correct outcome: "not found" is recoverable and lets the block
  // self-heal onto the right control, where filling the wrong one is silent damage.
  assert.throws(
    () => resolveTargetControl(controls, { id: "a3", tag: "input", label: "Email address" }),
    /not found/
  );

  // An abbreviated descriptor is still agreement, not contradiction.
  const controls2 = [{ id: "a17", text: "Account Manage your name, picture, and care network." }];
  assert.equal(
    (resolveTargetControl(controls2, { id: "a17", text: "Account" }) as { id: string }).id,
    "a17"
  );
});

void test("an unprepared environment is never reported as an app verdict", async () => {
  const { classifyOutcome, preconditionsFrom } = await import("../../src/utils/scenario-runner.mjs");

  assert.deepEqual(preconditionsFrom({ preconditions: [{ path: "/myday" }] }), [{ path: "/myday" }]);
  assert.deepEqual(preconditionsFrom({}), []);
  assert.deepEqual(preconditionsFrom({ preconditions: "nope" }), []);

  // The run never started, so no verdict about the product is available. Reporting
  // this as "blocked" pointed at a defect that did not exist.
  for (const error of [
    "Precondition not met: MyDay must show at least one task for today.",
    "Could not verify precondition (x): navigation failed"
  ]) {
    assert.equal(
      classifyOutcome({ status: "failed", error, metCriteria: 0, recoverableFailures: 3 }),
      "precondition-not-met"
    );
  }
});
