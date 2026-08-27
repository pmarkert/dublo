import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  classifyRecoverableActionError,
  executeBrowserAction,
  resolveSameOriginUrl,
  resolveTargetControl
} from "../../src/utils/scenario/action-executor.mjs";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";

const noopLogger = { info() {}, warn() {}, error() {} };
const noInterrupt = () => {};
const settle = { settleDelayMs: 1, settleTimeoutMs: 200 };

type ObservedControl = { id: string; label: string; focused?: boolean };
type Observation = {
  controls: ObservedControl[];
  focus: { tag: string; role?: string; label: string } | null;
};

void test("resolveSameOriginUrl resolves relative paths and blocks cross-origin", () => {
  assert.equal(
    resolveSameOriginUrl("/dashboard", "https://app.example.com/home", "https://app.example.com"),
    "https://app.example.com/dashboard"
  );
  assert.equal(
    resolveSameOriginUrl("https://app.example.com/x", "https://app.example.com/home", undefined),
    "https://app.example.com/x"
  );
  assert.throws(
    () =>
      resolveSameOriginUrl(
        "https://evil.example.net/x",
        "https://app.example.com/home",
        "https://app.example.com"
      ),
    /cross-origin and was blocked/
  );
  assert.throws(() => resolveSameOriginUrl("http://", undefined, undefined), /invalid/i);
});

void test("hover, press_key, and focus observation drive a real page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <a id="home" href="#home">Home</a>
      <div id="menu" style="display:none">Menu content</div>
      <button id="opener" onmouseenter="document.getElementById('menu').style.display='block'">Account</button>
      <input id="field" aria-label="Search" />
      <div id="typed"></div>
      <script>
        document.getElementById('field').addEventListener('keydown', (event) => {
          if (event.key === 'Enter') document.getElementById('typed').textContent = 'submitted';
        });
      </script>
    `);

    // hover reveals a menu that starts hidden.
    let observation = (await collectObservation(page, {}, "t1")) as Observation;
    const opener = observation.controls.find((control) => control.label === "Account");
    assert.ok(opener, "expected the Account button in the observation");
    await executeBrowserAction({
      page,
      action: { reason: "reveal menu", payload: { action: "hover", target: { id: opener.id } } },
      observation,
      turnToken: "t1",
      ...settle,
      logger: noopLogger,
      throwIfInterrupted: noInterrupt
    });
    assert.equal(await page.locator("#menu").isVisible(), true);

    // Clicking the input focuses it; the observation reports focus.
    observation = (await collectObservation(page, {}, "t2")) as Observation;
    const field = observation.controls.find((control) => control.label === "Search");
    assert.ok(field);
    await executeBrowserAction({
      page,
      action: { reason: "focus field", payload: { action: "click", target: { id: field.id } } },
      observation,
      turnToken: "t2",
      ...settle,
      logger: noopLogger,
      throwIfInterrupted: noInterrupt
    });

    observation = (await collectObservation(page, {}, "t3")) as Observation;
    assert.equal(observation.focus?.label, "Search");
    assert.ok(observation.controls.find((control) => control.label === "Search")?.focused);

    // press_key acts on the focused element.
    await executeBrowserAction({
      page,
      action: { reason: "submit", payload: { action: "press_key", key: "Enter" } },
      observation,
      turnToken: "t3",
      ...settle,
      logger: noopLogger,
      throwIfInterrupted: noInterrupt
    });
    assert.equal(await page.locator("#typed").textContent(), "submitted");
  } finally {
    await browser.close();
  }
});

void test("select_option accepts a live value beyond a truncated options list", async () => {
  type SelectControl = {
    id: string;
    label: string;
    text: string;
    options?: Array<{ value: string }>;
    optionsTruncated?: boolean;
    optionCount?: number;
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const optionMarkup = Array.from(
      { length: 60 },
      (_, index) => `<option value="y${1950 + index}">${1950 + index}</option>`
    ).join("");
    await page.setContent(`
      <label for="year">Birth year</label>
      <select id="year">${optionMarkup}</select>
    `);

    const observation = (await collectObservation(page, { maxOptionsPerControl: 10 }, "t1")) as {
      controls: SelectControl[];
    };
    const control = observation.controls.find((candidate) => candidate.label === "Birth year");
    assert.ok(control, "expected the select in the observation");

    // The observed list is truncated, says so, and text stays in lockstep with
    // it instead of advertising every option label.
    assert.equal(control.options?.length, 10);
    assert.equal(control.optionsTruncated, true);
    assert.equal(control.optionCount, 60);
    assert.match(control.text, /1959/);
    assert.doesNotMatch(control.text, /2009/);

    // A choice beyond the truncated list is validated against the live DOM,
    // and the visible label resolves to the option's real value attribute.
    await executeBrowserAction({
      page,
      action: {
        reason: "pick a year past the truncation point by its visible label",
        payload: { action: "select_option", target: { id: control.id }, value: "2005" }
      },
      observation,
      turnToken: "t1",
      ...settle,
      logger: noopLogger,
      throwIfInterrupted: noInterrupt
    });
    assert.equal(await page.locator("#year").inputValue(), "y2005");

    // The raw value attribute works beyond the cap too.
    await executeBrowserAction({
      page,
      action: {
        reason: "pick a year past the truncation point by value",
        payload: { action: "select_option", target: { id: control.id }, value: "y2001" }
      },
      observation,
      turnToken: "t1",
      ...settle,
      logger: noopLogger,
      throwIfInterrupted: noInterrupt
    });
    assert.equal(await page.locator("#year").inputValue(), "y2001");

    // A value that exists nowhere still fails fast.
    await assert.rejects(
      () =>
        executeBrowserAction({
          page,
          action: {
            reason: "pick a nonexistent year",
            payload: { action: "select_option", target: { id: control.id }, value: "1800" }
          },
          observation,
          turnToken: "t1",
          ...settle,
          logger: noopLogger,
          throwIfInterrupted: noInterrupt
        }),
      /value is not available/
    );
  } finally {
    await browser.close();
  }
});

void test("resolveTargetControl forgives guessed fields only against empty observed values", () => {
  const controls = [
    { id: "a4", tag: "input", type: "", label: "", text: "" },
    { id: "a5", tag: "button", label: "Continue", text: "Continue" }
  ];

  // A correct id plus a guessed attribute the observation never showed resolves.
  assert.equal(
    resolveTargetControl(controls, { id: "a4", tag: "input", type: "text" }),
    controls[0]
  );

  // A supplied field contradicting an observed NON-empty value fails - loudly,
  // as a field mismatch naming the field, so a stale id never silently resolves.
  assert.throws(
    () => resolveTargetControl(controls, { id: "a5", text: "Add task" }),
    /target field mismatch[\s\S]*'text'/
  );

  // Without an id there is no forgiveness.
  assert.throws(() => resolveTargetControl(controls, { text: "Nope" }), /target not found/);
});

void test("ambiguous selectors name their candidates and both selector failures are recoverable", () => {
  const controls = [
    { id: "a17", tag: "button", label: "Add task to today", text: "Add task to today" },
    { id: "a32", tag: "span", label: "Add task to today", text: "Add task to today" }
  ];

  let ambiguous;
  try {
    resolveTargetControl(controls, { label: "Add task to today" });
  } catch (error) {
    ambiguous = error;
  }
  assert.ok(ambiguous instanceof Error);
  assert.match(ambiguous.message, /ambiguous/);
  assert.match(ambiguous.message, /a17/);
  assert.match(ambiguous.message, /a32/);

  assert.equal(classifyRecoverableActionError(ambiguous), "ambiguous_target");
  assert.equal(
    classifyRecoverableActionError(new Error("Planner target field mismatch: id 'a5' ...")),
    "target_field_mismatch"
  );
});
