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

function createTreeNode() {
  return { childNodes: new Map(), items: [] };
}

function treeNodeForPath(root, path) {
  let node = root;
  for (const segment of path || []) {
    if (!node.childNodes.has(segment)) {
      const child = createTreeNode();
      node.childNodes.set(segment, child);
      node.items.push({ type: "node", label: segment, node: child });
    }
    node = node.childNodes.get(segment);
  }
  return node;
}

function relativePath(path, ancestorPath) {
  const normalizedPath = path || [];
  const normalizedAncestor = ancestorPath || [];
  return normalizedPath
    .slice(0, normalizedAncestor.length)
    .every((part, index) => part === normalizedAncestor[index])
    ? normalizedPath.slice(normalizedAncestor.length)
    : normalizedPath;
}

function pathWithinScrollContainer(control, container) {
  const path = relativePath(control.contextPath, container.contextPath);
  return path[0] === container.label ? path.slice(1) : path;
}

function renderActionableTree(controls, scrollContainers) {
  const root = createTreeNode();
  const containersById = new Map(scrollContainers.map((container) => [container.id, container]));
  const containerNodes = new Map();

  const insertScrollContainer = (container) => {
    if (containerNodes.has(container.id)) return containerNodes.get(container.id);
    const parentNode = treeNodeForPath(root, container.contextPath);
    const containerNode = createTreeNode();
    parentNode.items.push({ type: "scroll", container, node: containerNode });
    containerNodes.set(container.id, containerNode);
    return containerNode;
  };

  for (const control of controls) {
    const container = containersById.get(control.scrollContainerId);
    const parentNode = container ? insertScrollContainer(container) : root;
    const path = container ? pathWithinScrollContainer(control, container) : control.contextPath;
    treeNodeForPath(parentNode, path).items.push({ type: "control", control });
  }

  for (const container of scrollContainers) insertScrollContainer(container);

  const renderNode = (node, indent = "") =>
    node.items.flatMap((item) => {
      if (item.type === "node") {
        return [`${indent}- ${renderValue(item.label)}`, ...renderNode(item.node, `${indent}  `)];
      }
      if (item.type === "scroll") {
        const { container } = item;
        return [
          `${indent}- Scroll ${renderValue(container.id)} (${renderValue(container.label)}): can scroll up: ${container.canScrollUp}; can scroll down: ${container.canScrollDown}`,
          ...renderNode(item.node, `${indent}  `)
        ];
      }
      return [`${indent}${renderControl(item.control)}`];
    });

  return renderNode(root);
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
  const compactControls = redactedObservation.controls.map((control) => ({
    id: control.id,
    tag: control.tag,
    role: control.role,
    type: control.type,
    priority: control.priority,
    text: clip(control.text),
    label: clip(control.label),
    ariaLabel: clip(control.ariaLabel),
    placeholder: clip(control.placeholder),
    ...(control.description ? { description: clip(control.description) } : {}),
    ...(control.contextPath?.length ? { contextPath: control.contextPath } : {}),
    ...(control.scrollContainerId ? { scrollContainerId: control.scrollContainerId } : {}),
    ...(control.value ? { value: clip(control.value) } : {}),
    ...(control.options ? { options: control.options } : {}),
    hasValue: control.hasValue,
    checked: control.checked,
    required: Boolean(control.required),
    ...(typeof control.expanded === "boolean" ? { expanded: control.expanded } : {}),
    ...(typeof control.selected === "boolean" ? { selected: control.selected } : {}),
    ...(typeof control.pressed === "boolean" ? { pressed: control.pressed } : {}),
    ...(control.current ? { current: control.current } : {}),
    invalid: Boolean(control.invalid),
    disabled: Boolean(control.disabled)
  }));

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
    "Always provide a non-empty reason for the chosen action.",
    "If observation.modal.blocksBackground is true, only interact with controls listed from the blocking modal context.",
    "If observation.modal.open is true but observation.modal.blocksBackground is false, you may still use background controls when needed.",
    "Control IDs identify the same visible control across observations when it persists. Choose an ID from the current observation only; do not guess IDs for controls not currently observed.",
    "For click, fill, and select_option, set target to exactly { id: '<observed control ID>' }.",
    "Put action and action-specific fields in payload; keep reason at the root.",
    "Never emit click or fill without target.",
    "For fill actions, also provide a value.",
    "Treat checked, selected, and pressed as current control state. Do not click a control that is already in the state required by the objective.",
    "Use select_option only for an observed native select that includes an options list, using an observed option value. For an open custom combobox, click the visible role=option control instead.",
    "When an actionable Scroll entry has can scroll down or can scroll up, use scroll with its ID as containerId and the matching direction to reveal more content before escalating.",
    "Visible Page Text may describe content outside the current viewport. Only IDs in the actionable tree can be clicked, filled, or selected. Never invent an ID or substitute another actionable control for a control mentioned only in Visible Page Text. When the objective requires such a control, scroll actionable Scroll ancestors that can reveal more content.",
    "Important: completedWork is a durable record of successful work from this run and is authoritative evidence when deciding whether the objective is complete. Before choosing another action, compare the objective against completedWork. If it covers every success criterion, return finish; do not restart a completed workflow merely because its entry control is visible.",
    "Do not scroll only to re-verify completed work; use the current observation and completedWork to decide what remains. You might not be able to verify all fields on one screen at a time.",
    "A successful submit or save followed by visible confirmation of the saved item is sufficient persistence evidence. Do not reopen a saved item merely to inspect settings already recorded in completedWork unless the objective explicitly requires post-save verification or visible evidence contradicts it.",
    "Before finishing, do not try to audit every part of a long form from one viewport. Combine current visible evidence with completedWork; if all success criteria are covered, finish instead of alternating scroll directions.",
    ...(secretValues.size > 0
      ? [
          "Secret values are unavailable. Fill registered secrets with {{secret:path}}, using a path from availableSecretPaths."
        ]
      : []),
    "Do not fill the same field with a different value unless visible validation or error evidence shows correction is needed.",
    "Use observation.documentText as the main source of visible page text when deciding whether login or onboarding is still loading or has finished.",
    "The runner automatically waits for ordinary UI transitions to settle before each observation; do not wait merely to pause after an action.",
    "After a click or fill, do not repeat it based on an earlier observation. If its target is absent or disabled in the current observation, the UI is transitioning.",
    "When a persistent transition leaves an old screen visible but its submit control is absent or disabled, use wait_until_gone with expectGone.documentText set to visible text from that old screen which must disappear.",
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
    `- Modal: ${redactedObservation.modal.open ? renderValue(redactedObservation.modal.title || "open") : "none"}`,
    ...(redactedObservation.headings?.length
      ? [`- Headings: ${redactedObservation.headings.map(renderValue).join(", ")}`]
      : []),
    ...(redactedObservation.alerts?.length
      ? [`- Alerts: ${redactedObservation.alerts.map(renderValue).join(", ")}`]
      : []),
    "",
    "## Visible Page Text",
    clip(redactedObservation.documentText, 1600) || "(none)",
    "",
    "## Currently Actionable Controls",
    ...(compactControls.length || redactedObservation.scrollContainers?.length
      ? renderActionableTree(compactControls, redactedObservation.scrollContainers || [])
      : ["- None"]),
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
