import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRecoverableActionError,
  isDocumentTextGone,
  isAlternatingScrollLoop,
  resolveTargetControl
} from "../../src/utils/scenario-runner.mjs";
import {
  loadContextFromOperations,
  redactSecretValues,
  resolveFillValue
} from "../../src/utils/scenario/context-operations.mjs";
import { executeBrowserAction } from "../../src/utils/scenario/action-executor.mjs";
import { buildPlannerMessages } from "../../src/utils/scenario/planner-context.mjs";

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
      controls: [
        { id: "a1", label: "Continue", ariaLabel: "", text: "Continue", role: "", type: "button" }
      ],
      scrollContainers: []
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
          controls: [{ id: "a1", label: "Daily", role: "option", selected: true }],
          scrollContainers: []
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

  assert.match(messages.systemText, /checkout\.password/);
  assert.match(messages.systemText, /give_up/);
  assert.doesNotMatch(messages.systemText, /correct-horse-battery-staple/);
  assert.equal(messages.staticContextText, "");
  assert.match(messages.dynamicContextText, /\*{7}/);
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
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Routines",
      scrollContainers: [
        {
          id: "s1",
          label: "Routine form",
          contextPath: ["Create routine"],
          canScrollUp: false,
          canScrollDown: true
        }
      ],
      controls: [
        {
          id: "name",
          tag: "input",
          role: "",
          type: "text",
          priority: false,
          text: "",
          label: "Name",
          ariaLabel: "",
          placeholder: "Routine name",
          contextPath: ["Create routine", "Routine form", "form"],
          scrollContainerId: "s1",
          hasValue: false,
          checked: false
        },
        {
          id: "description",
          tag: "textarea",
          role: "",
          type: "",
          priority: false,
          text: "",
          label: "Description",
          ariaLabel: "",
          placeholder: "Routine description",
          contextPath: ["Create routine", "Routine form", "form"],
          scrollContainerId: "s1",
          hasValue: false,
          checked: false
        },
        {
          id: "duration",
          tag: "button",
          role: "",
          type: "button",
          priority: false,
          text: "Duration Not selected",
          label: "Add duration section",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Create routine", "Routine form", "form", "Duration"],
          scrollContainerId: "s1",
          hasValue: false,
          checked: false,
          expanded: false
        },
        {
          id: "close",
          tag: "button",
          role: "",
          type: "button",
          priority: false,
          text: "Close",
          label: "Close dialog",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Create routine"],
          hasValue: false,
          checked: false
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /set target to exactly/);
  assert.match(messages.systemText, /action and action-specific fields in payload/);
  assert.match(messages.systemText, /use scroll with its ID as containerId/);
  assert.match(
    messages.systemText,
    /Never invent an ID or substitute another actionable control for a control mentioned only in Visible Page Text/
  );
  assert.match(messages.dynamicContextText, /## Currently Actionable Controls/);
  assert.match(
    messages.dynamicContextText,
    /- `Create routine`\n  - Scroll `s1` \(`Routine form`\): can scroll up: false; can scroll down: true\n    - `form`\n      - `name`: label: `Name`; type: `text`; placeholder: `Routine name`\n      - `description`: label: `Description`; placeholder: `Routine description`\n      - `Duration`\n        - `duration`: label: `Add duration section`; text: `Duration Not selected`; type: `button`; collapsed\n  - `close`: label: `Close dialog`; text: `Close`; type: `button`/
  );
  assert.doesNotMatch(messages.dynamicContextText, /- `Routine form`\n/);
  assert.doesNotMatch(messages.dynamicContextText, /## Scroll Containers/);
  assert.doesNotMatch(messages.systemText, /You may combine any visible control fields/);
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
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Routines",
      controls: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.systemText, /set target to exactly/);
  assert.doesNotMatch(messages.systemText, /You may combine any visible control fields/);
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
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Home",
      scrollContainers: [
        { id: "s1", label: "main", contextPath: [], canScrollUp: false, canScrollDown: true }
      ],
      controls: [
        {
          id: "header",
          tag: "button",
          role: "",
          type: "button",
          priority: true,
          text: "Search",
          label: "Search",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Desktop header"],
          hasValue: false,
          checked: false
        },
        {
          id: "routine",
          tag: "a",
          role: "",
          type: "",
          priority: true,
          text: "Routines",
          label: "Routines",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Primary navigation"],
          hasValue: false,
          checked: false
        },
        {
          id: "task",
          tag: "button",
          role: "",
          type: "button",
          priority: false,
          text: "Add task",
          label: "Add task",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["main"],
          scrollContainerId: "s1",
          hasValue: false,
          checked: false
        },
        {
          id: "privacy",
          tag: "a",
          role: "",
          type: "",
          priority: false,
          text: "Privacy Policy",
          label: "Privacy Policy",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Application footer"],
          hasValue: false,
          checked: false
        }
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

void test("planner messages distinguish offscreen document text from actionable controls", () => {
  const messages = buildPlannerMessages({
    testPrompt: "Set the frequency to Daily.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    observation: {
      url: "https://example.test",
      title: "Create routine",
      modal: { open: true, title: "Create routine" },
      headings: [],
      alerts: [],
      documentText: "Schedule Frequency Daily Weekly",
      scrollContainers: [
        {
          id: "s1",
          label: "Create routine form",
          contextPath: ["Create routine"],
          canScrollUp: false,
          canScrollDown: true
        }
      ],
      controls: [
        {
          id: "name",
          tag: "input",
          role: "",
          type: "text",
          priority: false,
          text: "",
          label: "Name",
          ariaLabel: "",
          placeholder: "Routine name",
          contextPath: ["Create routine", "Create routine form", "form"],
          scrollContainerId: "s1",
          hasValue: true,
          checked: false,
          value: "Daily Breakfast"
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.dynamicContextText, /Visible Page Text\nSchedule Frequency Daily Weekly/);
  assert.match(
    messages.dynamicContextText,
    /Scroll `s1` \(`Create routine form`\): can scroll up: false; can scroll down: true/
  );
  assert.doesNotMatch(messages.dynamicContextText, /label: `Frequency`/);
  assert.doesNotMatch(messages.dynamicContextText, /label: `Daily`/);
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
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Home",
      controls: [
        {
          id: "a1",
          tag: "a",
          role: "",
          type: "",
          priority: true,
          text: "Routines",
          label: "Routines",
          ariaLabel: "",
          placeholder: "",
          contextPath: ["Primary navigation"],
          hasValue: false,
          checked: false
        }
      ]
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(
    messages.dynamicContextText,
    /- `Primary navigation`\n  - `a1`: label: `Routines`; text: `Routines`/
  );
  assert.doesNotMatch(messages.dynamicContextText, /context: `Primary navigation`/);
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

  assert.match(messages.systemText, /select_option/);
  assert.match(messages.systemText, /custom combobox/);
  assert.match(messages.systemText, /successful submit or save/);
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

  assert.match(
    messages.systemText,
    /do not restart a completed workflow merely because its entry control is visible/
  );
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
      modal: {},
      headings: [],
      alerts: [],
      documentText: "Form",
      controls: []
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
