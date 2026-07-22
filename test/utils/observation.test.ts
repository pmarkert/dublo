import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";

type Observation = {
  modal: {
    open: boolean;
    blocksBackground: boolean;
    role: string;
    ariaModal: string;
    title: string;
  };
  controls: Array<{ label: string; text: string; role: string; priority: boolean }>;
  scrollContainers: Array<{ contextPath: string[]; canScrollUp: boolean; canScrollDown: boolean }>;
};

void test("observes blocking modal controls, active overlay options, and scroll containers", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        #dialog { width: 320px; height: 220px; }
        #scroll-area { height: 60px; overflow-y: auto; }
        #scroll-content { height: 180px; }
        #offscreen { margin-top: 120px; }
      </style>
      <button id="outside">Background action</button>
      <section id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">Schedule</h2>
        <button id="inside">Save schedule</button>
        <button id="frequency" aria-expanded="true" aria-controls="frequency-options">Frequency</button>
        <div id="scroll-area"><div id="scroll-content">Scrollable details<button id="offscreen">Offscreen action</button></div></div>
      </section>
      <div id="frequency-options" role="listbox">
        <div role="option">Weekdays</div>
      </div>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;

    assert.deepEqual(observation.modal, {
      open: true,
      blocksBackground: true,
      role: "dialog",
      ariaModal: "true",
      title: "Schedule"
    });
    assert.equal(
      observation.controls.some((control) => control.label === "Background action"),
      false
    );
    assert.equal(
      observation.controls.some((control) => control.label === "Save schedule"),
      true
    );
    assert.equal(
      observation.controls.some(
        (control) => control.role === "option" && control.text === "Weekdays" && control.priority
      ),
      true
    );
    assert.equal(
      observation.controls.some((control) => control.label === "Offscreen action"),
      false
    );
    assert.equal(
      observation.scrollContainers.some((container) => container.canScrollDown),
      true
    );
  } finally {
    await browser.close();
  }
});
