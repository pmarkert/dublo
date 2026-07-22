import { redactSecretValues } from "./context-operations.mjs";

function clip(value, limit = 180) {
  if (!value) return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
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
  screenshotRequested,
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
    disabled: Boolean(control.disabled),
  }));

  const completedWork = actionHistory
    .filter(({ outcome, action }) => outcome === "ok" && !["scroll", "request_screenshot"].includes(action.payload.action))
    .map(({ step, action, target }) => ({
      step,
      action: action.payload.action,
      ...(target ? { target } : {}),
      ...(action.payload.action === "fill" ? { value: action.payload.value } : {}),
      ...(action.payload.action === "select_option" ? { value: action.payload.value } : {}),
      reason: clip(action.reason, 240),
    }));

  const staticContext = {
    contextData,
    ...(secretValues.size > 0 ? { availableSecretPaths: [...secretValues.keys()] } : {}),
    planningRules: [
      "Always provide a non-empty reason for the chosen action.",
      "If observation.modal.blocksBackground is true, only interact with controls listed from the blocking modal context.",
      "If observation.modal.open is true but observation.modal.blocksBackground is false, you may still use background controls when needed.",
      "Control IDs are assigned fresh on every observation. Choose an ID from the current observation only; never reuse an ID from a previous turn.",
      "For click, fill, and select_option, set target to exactly { id: '<observed control ID>' }.",
      "Put action and action-specific fields in payload; keep reason at the root.",
      "Never emit click or fill without target.",
      "For fill actions, also provide a value.",
      "Treat checked, selected, and pressed as current control state. Do not click a control that is already in the state required by the objective.",
      "Use select_option only for an observed native select that includes an options list, using an observed option value. For an open custom combobox, click the visible role=option control instead.",
      "When an observed scroll container has canScrollDown or canScrollUp, use scroll with its containerId and direction to reveal more content before escalating.",
      "Important: completedWork is a durable record of successful work from this run. Do not scroll only to re-verify completed work; use the current observation and completedWork to decide what remains. You might not be able to verify all fields on one screen at a time.",
      "A successful submit or save followed by visible confirmation of the saved item is sufficient persistence evidence. Do not reopen a saved item merely to inspect settings already recorded in completedWork unless the objective explicitly requires post-save verification or visible evidence contradicts it.",
      "Before finishing, do not try to audit every part of a long form from one viewport. Combine current visible evidence with completedWork; if all success criteria are covered, finish instead of alternating scroll directions.",
      ...(secretValues.size > 0
        ? ["Secret values are unavailable. Fill registered secrets with {{secret:path}}, using a path from availableSecretPaths."]
        : []),
      "Do not use the 'Continue with Google' login because the Google page will not load properly in this browser.",
      "Do not fill the same field with a different value unless visible validation or error evidence shows correction is needed.",
      "Use observation.documentText as the main source of visible page text when deciding whether login or onboarding is still loading or has finished.",
      "The runner automatically waits for ordinary UI transitions to settle before each observation; do not wait merely to pause after an action.",
      "After a click or fill, do not repeat it based on an earlier observation. If its target is absent or disabled in the current observation, the UI is transitioning.",
      "When a persistent transition leaves an old screen visible but its submit control is absent or disabled, use wait_until_gone with expectGone.documentText set to visible text from that old screen which must disappear.",
      "Do not repeat the same wait_until_gone condition unless a UI action or URL change has occurred.",
      "Do not return finish while the UI appears to be loading or transitioning.",
      "Before finish, verify visible evidence for the success criteria in the test prompt.",
      "Use give_up with a specific reason only after exhausting credible actions and no safe or reliable path to the objective remains.",
      "When the objective is completed, return finish.",
    ],
    humanEscalationRules: [
      "If you need a value not deducible from UI or contextData, such as an OTP code, use request_user_input.",
      "If you are blocked and need the human to do something in the browser, use request_user_interaction.",
      "If the structured observation is insufficient, use request_screenshot.",
    ],
  };

  const dynamicContext = {
    knownHumanInputs: Object.fromEntries(humanInputs.entries()),
    observation: {
      url: redactedObservation.url,
      title: redactedObservation.title,
      modal: redactedObservation.modal,
      headings: redactedObservation.headings,
      alerts: redactedObservation.alerts,
      documentText: clip(redactedObservation.documentText, 1600),
      scrollContainers: redactedObservation.scrollContainers || [],
      controls: compactControls,
    },
    screenshotRequested,
    completedWork: redactSecretValues(completedWork, secretValues),
    recentActions: actionHistory.slice(-10),
  };

  const systemText = [
    "You are an autonomous UX test agent driving a browser.",
    "Decide one next action at a time using only visible elements from the observation.",
    "Favor intuitive user behavior and avoid hidden shortcuts.",
    "Use the planner_action tool on every turn instead of replying with free text.",
    ...(workspacePromptText
      ? ["Application-specific background and testing instructions (apply throughout the run):", workspacePromptText]
      : []),
    "Persona instructions (apply throughout the run):",
    personaText,
    "Scenario objective and success criteria (apply throughout the run):",
    testPrompt,
  ].join(" ");

  const staticContextText = JSON.stringify({ staticContext }, null, 2);
  const dynamicContextText = JSON.stringify({ turnContext: dynamicContext }, null, 2);
  return { systemText, staticContextText, dynamicContextText, debugUserText: [staticContextText, dynamicContextText].join("\n\n") };
}