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
      </style>
      <button id="outside">Background action</button>
      <section id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">Schedule</h2>
        <button id="inside">Save schedule</button>
        <button id="frequency" aria-expanded="true" aria-controls="frequency-options">Frequency</button>
        <div id="scroll-area"><div id="scroll-content">Scrollable details</div></div>
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
      observation.scrollContainers.some((container) => container.canScrollDown),
      true
    );
  } finally {
    await browser.close();
  }
});

type RobustControl = {
  id: string;
  label: string;
  tag: string;
  nameSource: string;
  confidence: string;
  inferred?: boolean;
};

void test("pierces shadow DOM, resolves non-ARIA names, and infers non-semantic clickables", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="icon" title="Delete item"><svg aria-hidden="true"></svg></button>
      <button id="imgbtn"><img alt="Save file" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
      <div id="card" onclick="void 0" style="cursor:pointer">Open dashboard</div>
      <span id="ignored" style="cursor:pointer">${"x".repeat(80)}</span>
      <my-widget></my-widget>
      <script>
        const host = document.getElementById('my-widget') || document.querySelector('my-widget');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="shadow-btn">Inside shadow</button>';
      </script>
    `);

    const observation = (await collectObservation(page, {}, "t1")) as unknown as {
      controls: RobustControl[];
    };
    const byLabel = (label: string) =>
      observation.controls.find((control) => control.label === label);

    // Icon-only button with no text falls back to the title attribute.
    const iconButton = byLabel("Delete item");
    assert.ok(iconButton, "expected the title-named icon button");
    assert.equal(iconButton?.nameSource, "title");
    assert.equal(iconButton?.confidence, "low");

    // A button whose only content is an image falls back to the image alt text.
    const imageButton = byLabel("Save file");
    assert.ok(imageButton, "expected the image-alt named button");
    assert.equal(imageButton?.nameSource, "alt");

    // A <div onclick> with a pointer cursor is surfaced as an inferred control.
    const card = byLabel("Open dashboard");
    assert.ok(card, "expected the inferred clickable div");
    assert.equal(card?.inferred, true);

    // Long-text cursor:pointer elements with no explicit signal are not inferred.
    assert.equal(
      observation.controls.some((control) => control.id === "ignored"),
      false
    );

    // A control inside an open shadow root is visible to the walker.
    const shadowButton = byLabel("Inside shadow");
    assert.ok(shadowButton, "expected the shadow-DOM button");
    assert.equal(shadowButton?.tag, "button");

    // A locator can still reach the shadow control for interaction.
    const located = page.locator(`[data-agentic-id="${shadowButton?.id}"]`);
    assert.equal(await located.count(), 1);
    assert.equal(await located.innerText(), "Inside shadow");
  } finally {
    await browser.close();
  }
});
