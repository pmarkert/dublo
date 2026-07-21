import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlannerMessages,
  classifyRecoverableActionError,
  isDocumentTextGone,
  isAlternatingScrollLoop,
  loadContextFromOperations,
  redactSecretValues,
  resolveTargetControl,
  resolveFillValue
} from "../../src/utils/scenario-runner.mjs";

void test("detects when observed document text has disappeared", () => {
  assert.equal(isDocumentTextGone("Checking your account...", "checking YOUR account"), false);
  assert.equal(isDocumentTextGone("Welcome back", "Checking your account..."), true);
});

void test("waits until all configured document texts have disappeared", () => {
  assert.equal(
    isDocumentTextGone("Still loading your details...", ["Loading your account", "Still loading"]),
    false
  );
  assert.equal(isDocumentTextGone("Welcome back", ["Loading your account", "Still loading"]), true);
});

void test("treats targets that disappear during a transition as recoverable", () => {
  assert.equal(
    classifyRecoverableActionError(new Error("Planner target not found: a4")),
    "target_disappeared"
  );
});

void test("treats custom combobox selection as recoverable", () => {
  assert.equal(
    classifyRecoverableActionError(
      new Error('Planner select_option target is not a native select: {"id":"a4"}')
    ),
    "invalid_selection"
  );
});

void test("detects an alternating scroll loop in one container", () => {
  const actionHistory = ["down", "up", "down", "up"].map((direction) => ({
    outcome: "ok",
    action: { payload: { action: "scroll", containerId: "s1", direction } }
  }));

  assert.equal(
    isAlternatingScrollLoop(actionHistory, {
      action: "scroll",
      containerId: "s1",
      direction: "down"
    }),
    true
  );
  assert.equal(
    isAlternatingScrollLoop(actionHistory, {
      action: "scroll",
      containerId: "s2",
      direction: "down"
    }),
    false
  );
  assert.equal(
    isAlternatingScrollLoop(actionHistory, { action: "click", target: { id: "a1" } }),
    false
  );
  assert.equal(
    classifyRecoverableActionError(new Error("Alternating scroll loop detected in 's1'.")),
    "scroll_loop"
  );
});

void test("resolves exactly one control from all target selector properties", () => {
  const controls = [
    { id: "a1", tag: "button", text: "Continue", priority: false, checked: false },
    { id: "a2", tag: "button", text: "Continue", priority: true, checked: false }
  ];

  assert.deepEqual(
    resolveTargetControl(controls, { tag: "BUTTON", text: " continue ", priority: true }),
    controls[1]
  );
  assert.throws(
    () => resolveTargetControl(controls, { text: "Continue" }),
    /selector is ambiguous/
  );
  assert.throws(
    () => resolveTargetControl(controls, { label: "Email" }),
    /Planner target not found/
  );
});

void test("environment-backed secrets stay out of planner context and resolve only for fills", async () => {
  const { contextData, secretValues } = await loadContextFromOperations(
    [{ type: "secret", value: "checkout.password=CHECKOUT_PASSWORD" }],
    { CHECKOUT_PASSWORD: "correct-horse-battery-staple" }
  );

  assert.deepEqual(contextData, {});
  assert.deepEqual([...secretValues.keys()], ["checkout.password"]);
  assert.equal(
    resolveFillValue("{{secret:checkout.password}}", contextData, new Map(), secretValues),
    "correct-horse-battery-staple"
  );

  const messages = buildPlannerMessages({
    testPrompt: "Sign in.",
    personaText: "Test persona.",
    workspacePromptText: "",
    contextData,
    secretValues,
    observation: {
      url: "https://example.test",
      title: "Sign in",
      modal: {},
      headings: [],
      alerts: [],
      documentText: "correct-horse-battery-staple",
      controls: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.staticContextText, /checkout\.password/);
  assert.match(messages.staticContextText, /give_up/);
  assert.doesNotMatch(messages.staticContextText, /correct-horse-battery-staple/);
  assert.match(messages.dynamicContextText, /\*{7}/);
  assert.doesNotMatch(messages.dynamicContextText, /correct-horse-battery-staple/);
});

void test("strict planner messages require ID-only target selectors", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Create a routine.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Routines",
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Routines",
      scrollContainers: [{ id: "s1", canScrollUp: false, canScrollDown: true }],
      controls: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false,
    strictTargetSelectors: true
  });

  assert.match(messages.staticContextText, /Use only the visible control ID/);
  assert.match(messages.staticContextText, /action and action-specific fields in payload/);
  assert.match(messages.staticContextText, /use scroll with its containerId and direction/);
  assert.match(messages.dynamicContextText, /"scrollContainers"/);
  assert.doesNotMatch(messages.staticContextText, /You may combine any visible control fields/);
});

void test("planner messages include observed native select options", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Configure a schedule.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Schedule",
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Schedule",
      controls: [
        {
          id: "a1",
          tag: "select",
          role: "",
          type: "",
          priority: false,
          text: "Frequency",
          label: "Frequency",
          ariaLabel: "",
          placeholder: "",
          hasValue: true,
          checked: false,
          value: "daily",
          options: [
            { label: "Daily", value: "daily", selected: true },
            { label: "Weekdays", value: "weekdays" }
          ]
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.staticContextText, /select_option/);
  assert.match(messages.staticContextText, /custom combobox/);
  assert.match(messages.staticContextText, /successful submit or save/);
  assert.match(messages.dynamicContextText, /"label": "Weekdays"/);
  assert.match(messages.dynamicContextText, /"value": "weekdays"/);
});

void test("planner messages retain completed work beyond recent action history", () => {
  const actionHistory = Array.from({ length: 11 }, (_, index) => ({
    step: index + 1,
    outcome: "ok",
    target: { label: `Field ${index + 1}` },
    action: {
      reason: `Complete field ${index + 1}`,
      payload: { action: "fill", target: { id: "a1" }, value: `value ${index + 1}` }
    }
  }));

  const messages = buildPlannerMessages({
    testPrompt: "Complete the form.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Form",
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Form",
      controls: []
    },
    actionHistory,
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.dynamicContextText, /"completedWork"/);
  assert.match(messages.dynamicContextText, /Complete field 1/);
  assert.match(messages.dynamicContextText, /"Field 1"/);
});

void test("secret redaction masks only exact string matches", () => {
  const redacted: unknown = redactSecretValues(
    { exact: "token", embedded: "prefix-token", nested: ["token"] },
    new Map([["auth.token", "token"]])
  );

  assert.deepEqual(redacted, { exact: "*******", embedded: "prefix-token", nested: ["*******"] });
});

void test("DUBLO_SECRET variables are discovered without a CLI secret operation", async () => {
  const { secretValues } = await loadContextFromOperations([], {
    DUBLO_SECRET_password: "correct-horse-battery-staple",
    DUBLO_SECRET_checkout__token: "checkout-token"
  });

  assert.deepEqual([...secretValues.keys()], ["checkout.token", "password"]);
  assert.equal(secretValues.get("password"), "correct-horse-battery-staple");
});

void test("bare secret references require their DUBLO_SECRET variable", async () => {
  await assert.rejects(
    () => loadContextFromOperations([{ type: "secret", value: "password" }], {}),
    /Secret environment variable 'DUBLO_SECRET_password' is not set or is empty/
  );
});

void test("empty DUBLO_SECRET variables fail loudly", async () => {
  await assert.rejects(
    () => loadContextFromOperations([], { DUBLO_SECRET_password: "" }),
    /Secret environment variable 'DUBLO_SECRET_password' is not set or is empty/
  );
});
