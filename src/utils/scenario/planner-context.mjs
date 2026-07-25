import { redactSecretValues } from "./context-operations.mjs";

function clip(value, limit = 180) {
  if (!value) return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
}

function markdownText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function renderValue(value) {
  return `\`${markdownText(value)}\``;
}

function renderControl(control) {
  const details = [
    control.tag && `tag: ${renderValue(control.tag)}`,
    control.label && `label: ${renderValue(control.label)}`,
    control.text && `text: ${renderValue(control.text)}`,
    control.role && `role: ${renderValue(control.role)}`,
    control.type && `type: ${renderValue(control.type)}`,
    control.value && `value: ${renderValue(control.value)}`,
    control.placeholder && `placeholder: ${renderValue(control.placeholder)}`,
    control.selected && "selected",
    control.checked && "checked",
    control.pressed && "pressed",
    control.disabled && "disabled",
    control.expanded === true && "expanded",
    control.expanded === false && "collapsed"
  ].filter(Boolean);
  const options = control.options?.length
    ? `; options: ${control.options.map((option) => renderValue(option.label || option.value)).join(", ")}`
    : "";
  return `- ${renderValue(control.id)}: ${details.join("; ") || "control"}${options}`;
}

function renderPreviewControl(control) {
  const details = [
    control.tag && `tag: ${renderValue(control.tag)}`,
    control.label && `label: ${renderValue(control.label)}`,
    control.text && `text: ${renderValue(control.text)}`,
    control.role && `role: ${renderValue(control.role)}`,
    control.type && `type: ${renderValue(control.type)}`,
    control.description && `description: ${renderValue(control.description)}`
  ].filter(Boolean);
  return `- Preview: Control: ${details.join("; ") || "control"}`;
}

function renderTextNode(textNode) {
  return `- Text: ${renderValue(textNode.text)}`;
}

function renderObservationTree(nodes, indent = "") {
  return (nodes || []).flatMap((node) => {
    if (node.kind === "context") {
      return [`${indent}- ${renderValue(node.name)}`, ...renderObservationTree(node.children, `${indent}  `)];
    }
    if (node.kind === "dialog") {
      const label = node.role === "alertdialog" ? "Alert dialog" : "Dialog";
      return [
        `${indent}- ${label} ${renderValue(node.title)}; blocking: ${Boolean(node.blocking)}`,
        ...renderObservationTree(node.children, `${indent}  `)
      ];
    }
    if (node.kind === "scroll") {
      return [
        `${indent}- Scroll ${renderValue(node.id)} (${renderValue(node.label)}): can scroll up: ${Boolean(node.canScrollUp)}; can scroll down: ${Boolean(node.canScrollDown)}`,
        ...renderObservationTree(node.children, `${indent}  `)
      ];
    }
    if (node.kind === "preview") {
      return [
        `${indent}- Scroll ${node.direction} to reveal:`,
        ...renderObservationTree(node.children, `${indent}  `)
      ];
    }
    if (node.kind === "preview-heading") {
      return [`${indent}- Preview: Heading ${renderValue(node.text)} [level ${node.level}]`];
    }
    if (node.kind === "preview-text") return [`${indent}- Preview: Text: ${renderValue(node.text)}`];
    if (node.kind === "preview-control") return [`${indent}${renderPreviewControl(node)}`];
    if (node.kind === "heading") return [`${indent}- Heading ${renderValue(node.text)} [level ${node.level}]`];
    if (node.kind === "text") return [`${indent}- Text: ${renderValue(node.text)}`];
    if (node.kind === "alert") return [`${indent}- Alert: ${renderValue(node.text)}`];
    if (node.kind === "control") return [`${indent}${renderControl(node)}`];
    return [];
  });
}

function renderSuccessfulAction(item) {
  const target = item.target?.label || item.target?.ariaLabel || item.target?.text || "control";
  const value = item.value ? ` with ${renderValue(item.value)}` : "";
  return `- Step ${item.step}: ${item.action} ${renderValue(target)}${value}`;
}

export function buildPlannerMessages({
  testPrompt,
  personaText,
  workspacePromptText,
  contextData,
  observation,
  actionHistory,
  humanInputs,
  secretValues = new Map(),
  screenshotRequested
}) {
  const redactedObservation = redactSecretValues(observation, secretValues);

  const completedWork = actionHistory
    .filter(
      ({ outcome, action }) =>
        outcome === "ok" && !["scroll", "request_screenshot"].includes(action.payload.action)
    )
    .map(({ step, action, target }) => ({
      step,
      action: action.payload.action,
      ...(target ? { target } : {}),
      ...(action.payload.action === "fill" ? { value: action.payload.value } : {}),
      ...(action.payload.action === "select_option" ? { value: action.payload.value } : {}),
      reason: clip(action.reason, 240)
    }));

  const planningRules = [
    "Your first task on every turn is to determine whether completedWork and current visible evidence already achieve every scenario success criterion.",
    "If every success criterion is achieved, return finish immediately and do not take another browser action. Otherwise, identify the specific unmet criterion and choose exactly one action that advances it.",
    "Do not restart, recreate, or repeat a workflow whose successful completion is recorded in completedWork and confirmed by the current observation.",
    "Always provide a non-empty reason for the chosen action.",
    "Control IDs identify the same visible control across observations when it persists. Choose an ID from the current observation only; do not guess IDs for controls not currently observed.",
    "For click, fill, and select_option, set target to exactly { id: '<observed control ID>' }.",
    "Read the observation as a tree: indented names such as `Authentication` or `form` are semantic context only, never target IDs or scroll container IDs. A control line begins with its ID, and only a `Scroll <id>` line supplies a valid scroll container ID.",
    "Put action and action-specific fields in payload; keep reason at the root.",
    "Never emit click or fill without target.",
    "For fill actions, also provide a value.",
    "Treat checked, selected, and pressed as current control state. Do not click a control that is already in the state required by the objective.",
    "Use select_option only for an observed native select that includes an options list, using an observed option value. For an open custom combobox, click the visible role=option control instead.",
    "Use scroll only when the current observation contains a `Scroll <id>` entry with the requested direction available. If there is no Scroll entry, do not use a context name as containerId; take the visible action that advances the workflow instead.",
    "When a scroll preview names a control required by the objective and that control has no actionable ID, the next action must scroll the named container in the preview direction. Do not click a different visible control as a substitute.",
    "Scroll preview groups identify content outside the current viewport. After scrolling, reassess the new actionable hierarchy before selecting an observed ID.",
    "The chosen target's label, semantic path, and current state must directly support the reason. Do not claim to act on Schedule while targeting a control in another section.",
    "Only IDs in the actionable hierarchy can be clicked, filled, or selected. Never invent an ID or substitute another actionable control for unrelated semantic text. When the objective requires a control that is not present, scroll actionable Scroll ancestors that can reveal more content.",
    "Do not scroll only to re-verify completed work; use the current observation and completedWork to decide what remains. You might not be able to verify all fields on one screen at a time.",
    "A successful submit or save followed by a newly visible item matching data created in this run is sufficient persistence evidence. Do not reopen a saved item or begin another workflow unless the objective explicitly requires post-save verification or visible evidence contradicts it.",
    "Before finishing, do not try to audit every part of a long form from one viewport. Combine current visible evidence with completedWork; if all success criteria are covered, finish instead of alternating scroll directions.",
    ...(secretValues.size > 0
      ? [
          "Secret values are unavailable. Fill registered secrets with {{secret:path}}, using a path from availableSecretPaths."
        ]
      : []),
    "Do not fill the same field with a different value unless visible validation or error evidence shows correction is needed.",
    "Do not infer an absent field from a familiar workflow. After filling a visible identifier field, click its visible enabled Continue or submit control when that is the next available step; wait for the next observation before looking for a password field.",
    "The runner automatically waits for ordinary UI transitions to settle before each observation; do not wait merely to pause after an action.",
    "After a click or fill, do not repeat it based on an earlier observation. If its target is absent or disabled in the current observation, the UI is transitioning.",
    "For wait_until_gone, provide expectGone as an array of one or more selectors copied from currently observed tree nodes. Wait completes only when every selected node is absent from a fresh observation.",
    "Do not repeat the same wait_until_gone condition unless a UI action or URL change has occurred.",
    "Do not return finish while the UI appears to be loading or transitioning.",
    "Before finish, verify visible evidence for the success criteria in the test prompt.",
    "Use give_up with a specific reason only after exhausting credible actions and no safe or reliable path to the objective remains.",
    "When the objective is completed, return finish."
  ];
  const humanEscalationRules = [
    "If you need a value not deducible from UI or contextData, such as an OTP code, use request_user_input.",
    "If you are blocked and need the human to do something in the browser, use request_user_interaction.",
    "If the structured observation is insufficient, use request_screenshot."
  ];

  const previousActionFeedback = actionHistory.at(-1)?.runnerFeedback
    ? actionHistory.at(-1)
    : undefined;
  const redactedCompletedWork = redactSecretValues(completedWork, secretValues);
  const knownHumanInputs = Object.fromEntries(humanInputs.entries());

  const dynamicContextText = [
    "# Current Turn: Authoritative State",
    "Only IDs listed in **Currently Actionable Controls** are valid targets this turn. IDs mentioned in historical sections are invalid unless they appear again below.",
    "",
    "## Page",
    `- URL: ${renderValue(redactedObservation.url)}`,
    `- Title: ${renderValue(redactedObservation.title)}`,
    "",
    "## Currently Actionable Controls",
    ...(redactedObservation.tree?.length ? renderObservationTree(redactedObservation.tree) : ["- None"]),
    ...(screenshotRequested
      ? ["", "## Screenshot", "A screenshot of the current viewport is attached to this turn."]
      : []),
    ...(Object.keys(knownHumanInputs).length > 0
      ? [
          "",
          "# Human Inputs",
          ...Object.entries(knownHumanInputs).map(
            ([key, value]) => `- ${key}: ${renderValue(value)}`
          )
        ]
      : []),
    ...(previousActionFeedback
      ? [
          "",
          "# Previous Action Feedback: Must Address",
          `- Step ${previousActionFeedback.step}: ${previousActionFeedback.runnerFeedback}${previousActionFeedback.error ? ` Error: ${renderValue(previousActionFeedback.error)}` : ""}`
        ]
      : []),
    ...(redactedCompletedWork.length
      ? [
          "",
          "# Completed Work: Objective Evidence",
          "These actions succeeded in this run. Their IDs are invalid unless currently observed, but the actions are authoritative evidence for deciding whether the objective is already complete.",
          "If these actions cover every success criterion, return finish instead of beginning the workflow again.",
          ...redactedCompletedWork.map(renderSuccessfulAction)
        ]
      : [])
  ].join("\n");

  const systemText = [
    "# Role",
    "You are an autonomous UX test agent driving a browser.",
    "Decide one next action at a time using only visible elements from the observation.",
    "Favor intuitive user behavior and avoid hidden shortcuts.",
    "Use the planner_action tool on every turn instead of replying with free text.",
    "",
    "# Operating Rules",
    ...planningRules.map((rule) => `- ${rule}`),
    "",
    "# Escalation",
    ...humanEscalationRules.map((rule) => `- ${rule}`),
    ...(Object.keys(contextData).length > 0
      ? [
          "",
          "# Provided Context",
          ...Object.entries(contextData).map(([key, value]) => `- ${key}: ${renderValue(value)}`)
        ]
      : []),
    ...(secretValues.size > 0
      ? [
          "",
          "# Available Secret Paths",
          ...[...secretValues.keys()].map((path) => `- ${renderValue(path)}`)
        ]
      : []),
    "",
    "# Application Instructions",
    ...(workspacePromptText
      ? ["Application-specific background and testing instructions:", workspacePromptText]
      : []),
    "",
    "# Persona Instructions",
    personaText,
    "",
    "# Scenario Objective and Success Criteria",
    testPrompt
  ].join("\n");

  return {
    systemText,
    staticContextText: "",
    dynamicContextText,
    debugUserText: dynamicContextText
  };
}
