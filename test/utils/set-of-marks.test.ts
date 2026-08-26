import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";
import { drawSetOfMarks, clearSetOfMarks } from "../../src/utils/scenario/set-of-marks.mjs";

void test("set-of-marks overlays one labelled box per observed control and clears cleanly", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="one">First</button>
      <button id="two">Second</button>
      <a id="three" href="#x">Third</a>
    `);

    // Observation stamps data-agentic-id/turn on the controls.
    const observation = (await collectObservation(page, {}, "t7")) as unknown as {
      controls: Array<{ id: string }>;
    };
    const controlIds = observation.controls.map((control) => control.id);
    assert.ok(controlIds.length >= 3);

    const markCount = await drawSetOfMarks(page, "t7");
    assert.equal(markCount, controlIds.length);

    // Each control id appears as a label in the overlay, and the overlay exists.
    const overlayText = await page.locator("#dublo-set-of-marks").innerText();
    for (const id of controlIds) {
      assert.match(overlayText, new RegExp(`\\b${id}\\b`));
    }

    await clearSetOfMarks(page);
    assert.equal(await page.locator("#dublo-set-of-marks").count(), 0);
  } finally {
    await browser.close();
  }
});

void test("set-of-marks only marks the current turn's controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="one">Only</button>`);
    await collectObservation(page, {}, "t1");

    // A stale turn token should match nothing.
    assert.equal(await drawSetOfMarks(page, "t-does-not-exist"), 0);
    await clearSetOfMarks(page);
  } finally {
    await browser.close();
  }
});
