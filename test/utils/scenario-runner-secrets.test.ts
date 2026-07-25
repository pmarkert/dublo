import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRecoverableActionError,
  isAlternatingScrollLoop,
  isRepeatedClickLoop,
  resolveTargetControl
} from "../../src/utils/scenario-runner.mjs";
import {
  loadContextFromOperations,
  redactSecretValues,
  resolveFillValue
} from "../../src/utils/scenario/context-operations.mjs";
import { executeBrowserAction } from "../../src/utils/scenario/action-executor.mjs";
import { areExpectedNodesGone } from "../../src/utils/scenario/action-executor.mjs";
import { buildPlannerMessages } from "../../src/utils/scenario/planner-context.mjs";

void test("detects when a selected observed tree node has disappeared", () => {
  const loadingTree = [{ kind: "text", text: "Checking your account..." }];
  const completeTree = [{ kind: "heading", text: "Welcome back", level: 1 }];

  assert.equal(
    areExpectedNodesGone(loadingTree, [{ kind: "text", text: "Checking your account..." }]),
    false
  );
  assert.equal(
    areExpectedNodesGone(completeTree, [{ kind: "text", text: "Checking your account..." }]),
    true
  );
});

void test("waits until every configured tree-node selector is absent", () => {
  const loadingTree = [
    { kind: "text", text: "Still loading your details..." },
    { kind: "control", id: "submit", name: "Loading your account" }
  ];
  const completeTree = [{ kind: "heading", text: "Welcome back", level: 1 }];
  const expectedNodes = [
    { kind: "text", text: "Still loading your details..." },
    { kind: "control", name: "Loading your account" }
  ];

  assert.equal(
    areExpectedNodesGone(loadingTree, expectedNodes),
    false
  );
  assert.equal(areExpectedNodesGone(completeTree, expectedNodes), true);
});

void test("distinguishes invalid planner targets from targets that disappear during a transition", () => {
  assert.equal(
    classifyRecoverableActionError(
      new Error("Planner target is not in the current observation: a4")
    ),
    "invalid_target"
  );
  assert.equal(
    classifyRecoverableActionError(new Error("Planner target disappeared from the DOM: a4")),
    "target_disappeared"
  );
});

void test("treats selected options as recoverable no-op clicks", () => {
  assert.equal(
    classifyRecoverableActionError(new Error('Selected option before click: {"id":"a4"}')),
    "already_selected"
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
  assert.equal(
    classifyRecoverableActionError(new Error("Planner scroll container 's1' cannot scroll down.")),
    "scroll_boundary"
  );
  assert.equal(
    classifyRecoverableActionError(
      new Error("Planner scroll container 'Authentication' is not in the observation.")
    ),
    "invalid_target"
  );
});

void test("detects repeated clicks on the same target", () => {
  const actionHistory = Array.from({ length: 3 }, () => ({
    outcome: "ok",
    action: { payload: { action: "click", target: { id: "description" } } }
  }));

  assert.equal(
    isRepeatedClickLoop(actionHistory, { action: "click", target: { id: "description" } }),
    true
  );
  assert.equal(
    isRepeatedClickLoop(actionHistory, { action: "click", target: { id: "name" } }),
    false
  );
  assert.equal(
    isRepeatedClickLoop(actionHistory, { action: "fill", target: { id: "description" } }),
    false
  );
  assert.equal(
    classifyRecoverableActionError(
      new Error("Repeated click loop detected for target 'description'.")
    ),
    "click_loop"
  );
});

void test("executes a click against the turn-scoped observed control", async () => {
  let clicked = false;
  const target = {
    count: () => Promise.resolve(1),
    evaluate: () => Promise.resolve(false),
    click: () => {
      clicked = true;
      return Promise.resolve();
    }
  };
  const page = {
    locator: () => ({ first: () => target }),
    waitForLoadState: () => Promise.resolve(),
    evaluate: () => Promise.resolve("stable"),
    waitForTimeout: async () => new Promise((resolve) => setTimeout(resolve, 1))
  };

  const result = await executeBrowserAction({
    page,
    action: { payload: { action: "click", target: { id: "a1" } } },
    observation: {
        tree: [
          { kind: "control", id: "a1", label: "Continue", text: "Continue", type: "button" }
        ]
    },
    turnToken: "t1",
    contextData: {},
    humanInputs: new Map(),
    secretValues: new Map(),
    settleDelayMs: 1,
    settleTimeoutMs: 20,
    logger: { info: () => {} },
    throwIfInterrupted: () => {}
  });

  assert.equal(clicked, true);
  assert.deepEqual(result.target, { label: "Continue", text: "Continue", type: "button" });
});

void test("does not click an already selected option", async () => {
  const target = {
    count: () => Promise.resolve(1),
    evaluate: () => Promise.resolve(false),
    click: () => Promise.resolve()
  };
  const page = {
    locator: () => ({ first: () => target })
  };

  await assert.rejects(
    () =>
      executeBrowserAction({
        page,
        action: { payload: { action: "click", target: { id: "a1" } } },
        observation: {
            tree: [{ kind: "control", id: "a1", label: "Daily", role: "option", selected: true }]
        },
        turnToken: "t1",
        contextData: {},
        humanInputs: new Map(),
        secretValues: new Map(),
        settleDelayMs: 1,
        settleTimeoutMs: 20,
        logger: { info: () => {} },
        throwIfInterrupted: () => {}
      }),
    /Selected option before click/
  );
});

void test("resolves exactly one control from all target selector properties", () => {
  const tree = [
    { kind: "control", id: "a1", tag: "button", text: "Continue", priority: false, checked: false },
    { kind: "control", id: "a2", tag: "button", text: "Continue", priority: true, checked: false }
  ];

  assert.deepEqual(
    resolveTargetControl(tree, { tag: "BUTTON", text: " continue ", priority: true }),
    tree[1]
  );
  assert.throws(
    () => resolveTargetControl(tree, { text: "Continue" }),
    /selector is ambiguous/
  );
  assert.throws(
    () => resolveTargetControl(tree, { label: "Email" }),
    /Planner target is not in the current observation/
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
  assert.equal(
    resolveFillValue("{{context:email}}", { email: "user@example.test" }, new Map()),
    "user@example.test"
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
      tree: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /checkout\.password/);
  assert.match(messages.systemText, /give_up/);
  assert.doesNotMatch(messages.systemText, /correct-horse-battery-staple/);
  assert.equal(messages.staticContextText, "");
  assert.doesNotMatch(messages.dynamicContextText, /correct-horse-battery-staple/);
});

void test("planner messages require ID-only target selectors", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Create a routine.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Routines",
      tree: [
        {
          kind: "dialog",
          title: "Create routine",
          blocking: true,
          children: [
            {
              kind: "scroll",
              id: "s1",
              label: "Routine form",
              canScrollUp: false,
              canScrollDown: true,
              children: [
                {
                  kind: "context",
                  name: "form",
                  children: [
                    { kind: "control", id: "name", tag: "input", type: "text", label: "Name", placeholder: "Routine name" },
                    { kind: "control", id: "description", tag: "textarea", label: "Description", placeholder: "Routine description" },
                    { kind: "context", name: "Duration", children: [{ kind: "control", id: "duration", tag: "button", type: "button", label: "Add duration section", text: "Duration Not selected", expanded: false }] }
                  ]
                }
              ]
            },
            { kind: "control", id: "close", tag: "button", type: "button", label: "Close dialog", text: "Close" }
          ]
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /set target to exactly/);
  assert.match(messages.systemText, /action and action-specific fields in payload/);
  assert.match(messages.systemText, /only a `Scroll <id>` line supplies a valid scroll container ID/);
  assert.match(messages.systemText, /semantic context only/);
  assert.match(messages.systemText, /Never invent an ID or substitute another actionable control/);
  assert.match(messages.dynamicContextText, /## Currently Actionable Controls/);
  assert.match(
    messages.dynamicContextText,
    /- Dialog `Create routine`; blocking: true\n  - Scroll `s1` \(`Routine form`\): can scroll up: false; can scroll down: true\n    - `form`\n      - `name`: tag: `input`; label: `Name`; type: `text`; placeholder: `Routine name`\n      - `description`: tag: `textarea`; label: `Description`; placeholder: `Routine description`\n      - `Duration`\n        - `duration`: tag: `button`; label: `Add duration section`; text: `Duration Not selected`; type: `button`; collapsed\n  - `close`: tag: `button`; label: `Close dialog`; text: `Close`; type: `button`/
  );
  assert.doesNotMatch(messages.dynamicContextText, /- `Routine form`\n/);
  assert.doesNotMatch(messages.dynamicContextText, /## Scroll Containers/);
  assert.doesNotMatch(messages.systemText, /You may combine any visible control fields/);
});

void test("planner messages distinguish semantic context from scroll container IDs", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Sign in.",
    personaText: "persona",
    workspacePromptText: "Use email/password login.",
    contextData: { email: "user@example.test" },
    observation: {
      url: "https://example.test/login",
      title: "Sign in",
      tree: [
        {
          kind: "context",
          name: "Authentication",
          children: [
            {
              kind: "context",
              name: "form",
              children: [
                { kind: "control", id: "email", tag: "input", type: "text", label: "Email", value: "user@example.test" },
                { kind: "control", id: "continue", tag: "button", type: "submit", label: "Continue with email", text: "Continue with email" }
              ]
            }
          ]
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /`Authentication` or `form` are semantic context only/);
  assert.match(messages.systemText, /If there is no Scroll entry, do not use a context name as containerId/);
  assert.match(messages.systemText, /Do not infer an absent field from a familiar workflow/);
  assert.match(messages.dynamicContextText, /- `Authentication`\n  - `form`\n    - `email`/);
  assert.doesNotMatch(messages.dynamicContextText, /Scroll `Authentication`/);
});

void test("planner messages do not permit target-selector fallbacks", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Create a routine.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Routines",
      tree: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /set target to exactly/);
  assert.doesNotMatch(messages.systemText, /You may combine any visible control fields/);
  assert.doesNotMatch(messages.systemText, /observation\.modal\.blocksBackground/);
  assert.doesNotMatch(messages.systemText, /background controls/);
});

void test("planner messages place a scroll container at its first owned control", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Open Routines.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Home",
      tree: [
        { kind: "context", name: "Desktop header", children: [{ kind: "control", id: "header", tag: "button", type: "button", label: "Search", text: "Search", priority: true }] },
        { kind: "context", name: "Primary navigation", children: [{ kind: "control", id: "routine", tag: "a", label: "Routines", text: "Routines", priority: true }] },
        { kind: "scroll", id: "s1", label: "main", canScrollUp: false, canScrollDown: true, children: [{ kind: "context", name: "main", children: [{ kind: "control", id: "task", tag: "button", type: "button", label: "Add task", text: "Add task" }] }] },
        { kind: "context", name: "Application footer", children: [{ kind: "control", id: "privacy", tag: "a", label: "Privacy Policy", text: "Privacy Policy" }] }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  const text = messages.dynamicContextText;
  assert.ok(text.indexOf("`Desktop header`") < text.indexOf("`Primary navigation`"));
  assert.ok(text.indexOf("`Primary navigation`") < text.indexOf("Scroll `s1`"));
  assert.ok(text.indexOf("Scroll `s1`") < text.indexOf("`Application footer`"));
});

void test("planner messages render scroll previews in the actionable hierarchy", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Set the frequency to Daily.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Create routine",
      tree: [
        {
          kind: "dialog",
          title: "Create routine",
          blocking: true,
          children: [
            {
              kind: "scroll",
              id: "s1",
              label: "Create routine form",
              canScrollUp: false,
              canScrollDown: true,
              children: [
                {
                  kind: "context",
                  name: "form",
                  children: [{ kind: "control", id: "name", tag: "input", type: "text", label: "Name", placeholder: "Routine name", value: "Daily Breakfast" }]
                },
                {
                  kind: "preview",
                  direction: "down",
                  children: [
                    { kind: "preview-heading", text: "Schedule", level: 2 },
                    { kind: "preview-control", label: "Frequency", text: "Frequency", type: "button" }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.doesNotMatch(messages.dynamicContextText, /Visible Page Text/);
  assert.doesNotMatch(messages.dynamicContextText, /Schedule Frequency Daily Weekly/);
  assert.match(
    messages.dynamicContextText,
    /Scroll `s1` \(`Create routine form`\): can scroll up: false; can scroll down: true/
  );
  assert.match(
    messages.dynamicContextText,
    /    - Scroll down to reveal:\n      - Preview: Heading `Schedule` \[level 2\]\n      - Preview: Control: label: `Frequency`; text: `Frequency`; type: `button`/
  );
  assert.match(
    messages.systemText,
    /the next action must scroll the named container in the preview direction/
  );
  assert.doesNotMatch(messages.dynamicContextText, /label: `Daily`/);
  assert.doesNotMatch(messages.dynamicContextText, /- `Frequency`:/);
  assert.doesNotMatch(messages.dynamicContextText, /\n      - Control:/);
});

void test("planner messages place visible and preview text in the semantic hierarchy", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Review the routine guidance.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Routines",
      tree: [{ kind: "context", name: "main", children: [{ kind: "heading", text: "Routines", level: 1 }, { kind: "text", text: "A routine repeats its tasks on a schedule." }, { kind: "scroll", id: "s1", label: "Routine details", canScrollUp: false, canScrollDown: true, children: [{ kind: "preview", direction: "down", children: [{ kind: "preview-text", text: "Additional schedule guidance below." }] }] }] }]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(
    messages.dynamicContextText,
    /- `main`\n  - Heading `Routines` \[level 1\]\n  - Text: `A routine repeats its tasks on a schedule\.`/
  );
  assert.match(
    messages.dynamicContextText,
    /    - Scroll down to reveal:\n      - Preview: Text: `Additional schedule guidance below\.`/
  );
});

void test("planner messages nest observed controls under their semantic context", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Open the routines page.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Home",
      tree: [{ kind: "context", name: "Primary navigation", children: [{ kind: "control", id: "a1", tag: "a", label: "Routines", text: "Routines", priority: true }] }]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(
    messages.dynamicContextText,
    /- `Primary navigation`\n  - `a1`: tag: `a`; label: `Routines`; text: `Routines`/
  );
  assert.doesNotMatch(messages.dynamicContextText, /context: `Primary navigation`/);
});

void test("planner messages render dialogs and headings in the semantic hierarchy", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Create a routine.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Routines",
      tree: [{ kind: "dialog", role: "dialog", title: "Create routine", blocking: true, children: [{ kind: "heading", text: "Schedule", level: 3 }, { kind: "control", id: "name", tag: "input", type: "text", label: "Name", placeholder: "Routine name" }, { kind: "alert", text: "Required fields are missing" }] }]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  const text = messages.dynamicContextText;
  assert.match(
    text,
    /- Dialog `Create routine`; blocking: true\n  - Heading `Schedule` \[level 3\]\n  - `name`:/
  );
  assert.match(text, /- Alert: `Required fields are missing`/);
  assert.doesNotMatch(text, /- Modal:/);
  assert.doesNotMatch(text, /- Headings:/);
  assert.doesNotMatch(text, /- Alerts:/);
  assert.doesNotMatch(text, /Heading `Create routine`/);
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
      tree: [{ kind: "control", id: "a1", tag: "select", text: "Frequency", label: "Frequency", value: "daily", options: [{ label: "Daily", value: "daily", selected: true }, { label: "Weekdays", value: "weekdays" }] }]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /select_option/);
  assert.match(messages.systemText, /custom combobox/);
  assert.match(messages.systemText, /newly visible item matching data created in this run/);
  assert.match(messages.dynamicContextText, /options: `Daily`, `Weekdays`/);
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
      tree: []
    },
    actionHistory,
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(
    messages.systemText,
    /Your first task on every turn is to determine whether completedWork and current visible evidence/
  );
  assert.match(
    messages.systemText,
    /If every success criterion is achieved, return finish immediately/
  );
  assert.match(messages.systemText, /Do not restart, recreate, or repeat a workflow/);
  assert.match(messages.dynamicContextText, /# Completed Work: Objective Evidence/);
  assert.match(
    messages.dynamicContextText,
    /return finish instead of beginning the workflow again/
  );
  assert.match(messages.dynamicContextText, /fill `Field 1` with `value 1`/);
});

void test("planner messages render feedback only from the immediately preceding action", () => {
  const baseArguments = {
    testPrompt: "Complete the form.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Form",
      tree: []
    },
    humanInputs: new Map(),
    screenshotRequested: false
  };

  const withoutFeedback = buildPlannerMessages({ ...baseArguments, actionHistory: [] });
  assert.doesNotMatch(
    withoutFeedback.dynamicContextText,
    /# Previous Action Feedback: Must Address/
  );

  const failedAction = {
    step: 1,
    outcome: "invalid_target",
    runnerFeedback:
      "The action targeted a control that is not in the current list of available controls.",
    error: 'Planner target is not in the current observation: {"id":"ctl_missing"}',
    action: {
      reason: "Choose Daily.",
      payload: { action: "click", target: { id: "ctl_missing" } }
    }
  };
  const withFeedback = buildPlannerMessages({
    ...baseArguments,
    actionHistory: [failedAction]
  });

  assert.match(withFeedback.dynamicContextText, /# Previous Action Feedback: Must Address/);
  assert.match(withFeedback.dynamicContextText, /not in the current list of available controls/);
  assert.match(
    withFeedback.dynamicContextText,
    /Error: `Planner target is not in the current observation: \{"id":"ctl_missing"\}`/
  );

  const feedbackClearsAfterSuccess = buildPlannerMessages({
    ...baseArguments,
    actionHistory: [
      failedAction,
      {
        step: 2,
        outcome: "ok",
        action: {
          reason: "Choose the available option.",
          payload: { action: "click", target: { id: "ctl_daily" } }
        }
      }
    ]
  });
  assert.doesNotMatch(
    feedbackClearsAfterSuccess.dynamicContextText,
    /# Previous Action Feedback: Must Address/
  );
  assert.doesNotMatch(withFeedback.dynamicContextText, /# Recent Actions/);
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
