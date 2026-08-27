import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  classifyRecoverableActionError,
  executeBrowserAction,
  resolveTargetControl
} from "../../src/utils/scenario/action-executor.mjs";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";

const noopLogger = { info() {}, warn() {}, error() {} };
const noInterrupt = () => {};
const settle = { settleDelayMs: 1, settleTimeoutMs: 200 };

type Control = {
  id: string;
  tag: string;
  label: string;
  text: string;
  disabled?: boolean;
  inferred?: boolean;
};
type Observation = { controls: Control[]; documentText: string };

// Mirrors shadcn/ui's default button, whose base class includes
// `disabled:pointer-events-none`.
const SHADCN_FORM = `
  <style>
    .btn:disabled { pointer-events: none; opacity: 0.5; }
    .inert-tile { pointer-events: none; cursor: pointer; }
  </style>
  <form>
    <label for="email">Email address</label>
    <input id="email" />
    <button class="btn" type="submit" disabled>Continue with email</button>
    <button class="btn" type="button">Sign in with a passkey</button>
  </form>
  <span class="inert-tile">Decorative tile</span>
`;

async function observe(html: string, config: Record<string, unknown> = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  const observation = (await collectObservation(page, config, "t1")) as Observation;
  return { browser, page, observation };
}

void test("a disabled button with pointer-events:none is observed with disabled:true", async () => {
  const { browser, observation } = await observe(SHADCN_FORM);
  try {
    const submit = observation.controls.find((c) => c.text === "Continue with email");
    assert.ok(submit, "the disabled submit button must appear in controls[]");
    assert.equal(submit.disabled, true);
    // The enabled sibling is unaffected.
    const passkey = observation.controls.find((c) => c.text === "Sign in with a passkey");
    assert.ok(passkey);
    assert.notEqual(passkey.disabled, true);
  } finally {
    await browser.close();
  }
});

void test("clicking the disabled control is a recoverable disabled_target, not a missing control", async () => {
  const { browser, page, observation } = await observe(SHADCN_FORM);
  try {
    const submit = observation.controls.find((c) => c.text === "Continue with email");
    assert.ok(submit);

    let thrown: unknown;
    try {
      await executeBrowserAction({
        page,
        action: {
          reason: "submit the form",
          payload: { action: "click", target: { id: submit.id } }
        },
        observation,
        turnToken: "t1",
        ...settle,
        logger: noopLogger,
        throwIfInterrupted: noInterrupt
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, "clicking a disabled control must throw");
    assert.equal(classifyRecoverableActionError(thrown), "disabled_target");
  } finally {
    await browser.close();
  }
});

void test("an inferred cursor:pointer element with pointer-events:none stays excluded", async () => {
  const { browser, observation } = await observe(SHADCN_FORM);
  try {
    assert.equal(
      observation.controls.some((c) => c.text === "Decorative tile"),
      false,
      "the pointer-events heuristic must be preserved for non-semantic clickables"
    );
  } finally {
    await browser.close();
  }
});

void test("a control whose name appears in documentText also appears in controls[]", async () => {
  const { browser, observation } = await observe(SHADCN_FORM);
  try {
    assert.match(observation.documentText, /Continue with email/);
    const names = observation.controls.map((c) => `${c.label} ${c.text}`).join(" | ");
    assert.match(names, /Continue with email/);
  } finally {
    await browser.close();
  }
});

void test("an offscreen disabled control follows interactionScope", async () => {
  const html = `
    <style>.btn:disabled { pointer-events: none; }</style>
    <div style="height: 4000px"></div>
    <button class="btn" disabled>Way below the fold</button>
  `;
  const viewport = await observe(html, { interactionScope: "viewport" });
  try {
    assert.equal(
      viewport.observation.controls.some((c) => c.text === "Way below the fold"),
      false
    );
  } finally {
    await viewport.browser.close();
  }

  const document = await observe(html, { interactionScope: "document" });
  try {
    assert.equal(
      document.observation.controls.some((c) => c.text === "Way below the fold"),
      true
    );
  } finally {
    await document.browser.close();
  }
});

void test("a label clipped for the planner still verifies against the full observed value", () => {
  const longLabel = `Accept the ${"very ".repeat(60)}long terms`;
  const clipped = `${longLabel.slice(0, 179)}...`;
  const controls = [{ id: "a1", tag: "button", label: longLabel, text: longLabel }];

  // The model echoes back what it was shown (clipped); that must verify.
  assert.equal(resolveTargetControl(controls, { id: "a1", label: clipped }), controls[0]);
  // A genuinely different label is still a mismatch.
  assert.throws(
    () => resolveTargetControl(controls, { id: "a1", label: "Something else entirely" }),
    /target field mismatch/
  );
});
