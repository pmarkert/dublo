import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";
import { buildPlannerMessages } from "../../src/utils/scenario/planner-context.mjs";

type Control = { id: string; label: string; text: string; fingerprint: string };
type Observation = { controls: Control[] };

const PAGE = `
  <form aria-label="Signup">
    <label for="email">Email</label><input id="email" />
    <button type="submit">Continue</button>
  </form>
  <ul>
    <li><button>Delete</button></li>
    <li><button>Delete</button></li>
  </ul>
`;

async function observe(html: string, turn: string): Promise<Observation> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return (await collectObservation(page, {}, turn)) as Observation;
  } finally {
    await browser.close();
  }
}

void test("fingerprints are stable across turns and runs while ids are not", async () => {
  const first = await observe(PAGE, "t1");
  // A second, independent browser/run over the same markup.
  const second = await observe(PAGE, "t7");

  const emailFirst = first.controls.find((control) => control.label === "Email");
  const emailSecond = second.controls.find((control) => control.label === "Email");
  assert.ok(emailFirst?.fingerprint);
  assert.ok(emailSecond?.fingerprint);
  assert.equal(emailFirst.fingerprint, emailSecond.fingerprint);

  // Distinct controls get distinct fingerprints.
  const submit = first.controls.find((control) => control.text === "Continue");
  assert.ok(submit);
  assert.notEqual(submit.fingerprint, emailFirst.fingerprint);
});

void test("a changed accessible name changes the fingerprint (drift is detectable)", async () => {
  const before = await observe(PAGE, "t1");
  const after = await observe(PAGE.replace(">Continue<", ">Continue to payment<"), "t1");

  const beforeSubmit = before.controls.find((control) => control.text === "Continue");
  const afterSubmit = after.controls.find((control) => control.text === "Continue to payment");
  assert.ok(beforeSubmit?.fingerprint);
  assert.ok(afterSubmit?.fingerprint);
  assert.notEqual(beforeSubmit.fingerprint, afterSubmit.fingerprint);
});

void test("identical repeated rows share a fingerprint by design", async () => {
  const observation = await observe(PAGE, "t1");
  const deletes = observation.controls.filter((control) => control.text === "Delete");
  assert.equal(deletes.length, 2);
  // Collision is accepted: fingerprints never address controls (ids do), so
  // this only softens drift detection for repeated rows.
  assert.equal(deletes[0]?.fingerprint, deletes[1]?.fingerprint);
  assert.notEqual(deletes[0]?.id, deletes[1]?.id);
});

void test("fingerprints are never sent to the planner", async () => {
  const observation = await observe(PAGE, "t1");
  const fingerprints = observation.controls.map((control) => control.fingerprint);
  assert.ok(fingerprints.every(Boolean));

  const messages = buildPlannerMessages({
    testPrompt: "Sign up.",
    personaText: "persona",
    workspacePromptText: "",
    contextData: {},
    secretValues: new Map(),
    observation,
    actionHistory: [
      {
        step: 1,
        url: "https://example.test/",
        action: { reason: "click", payload: { action: "click", target: { id: "a1" } } },
        target: { label: "Continue" },
        fingerprint: fingerprints[0],
        outcome: "ok"
      }
    ],
    humanInputs: new Map(),
    screenshotRequested: false,
    strictTargetSelectors: false
  }) as { systemText: string; staticContextText: string; dynamicContextText: string };

  const wire = `${messages.systemText}\n${messages.staticContextText}\n${messages.dynamicContextText}`;
  assert.doesNotMatch(wire, /fingerprint/i);
  for (const fingerprint of fingerprints) {
    assert.ok(
      !wire.includes(fingerprint),
      `fingerprint ${fingerprint} leaked into the planner prompt`
    );
  }
});
