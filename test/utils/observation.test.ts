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
  controls: Array<{
    id: string;
    label: string;
    text: string;
    role: string;
    priority: boolean;
    contextPath: string[];
    scrollContainerId?: string;
  }>;
  scrollContainers: Array<{
    id: string;
    label?: string;
    contextPath: string[];
    canScrollUp: boolean;
    canScrollDown: boolean;
  }>;
  headingNodes: Array<{
    text: string;
    level: number;
    contextPath: string[];
    scrollContainerId?: string;
  }>;
  scrollPreviews: Array<{
    kind: string;
    label?: string;
    scrollContainerId: string;
    revealDirection: string;
  }>;
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
        <div id="scroll-area"><form><button>Visible form action</button><div id="scroll-content">Scrollable details<button id="offscreen">Offscreen action</button></div></form></div>
        <button>Close dialog</button>
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
    assert.deepEqual(
      observation.scrollContainers.find((container) => container.id === "s1"),
      {
        id: "s1",
        label: "Schedule form",
        contextPath: ["Schedule"],
        canScrollUp: false,
        canScrollDown: true
      }
    );
    assert.equal(
      observation.controls.find((control) => control.label === "Visible form action")
        ?.scrollContainerId,
      "s1"
    );
    assert.equal(
      observation.controls.find((control) => control.label === "Close dialog")?.scrollContainerId,
      undefined
    );
    assert.deepEqual(
      observation.scrollPreviews.map(({ kind, label, scrollContainerId, revealDirection }) => [
        kind,
        label,
        scrollContainerId,
        revealDirection
      ]),
      [["control", "Offscreen action", "s1", "down"]]
    );
    assert.deepEqual(
      observation.headingNodes.map((heading) => [heading.text, heading.level, heading.contextPath]),
      [["Schedule", 2, ["Schedule"]]]
    );
  } finally {
    await browser.close();
  }
});

void test("labels a scrollable navigation landmark from its accessible name", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        nav { height: 60px; overflow-y: auto; }
        ul { height: 180px; }
      </style>
      <nav aria-label="Primary navigation"><ul><li>Home</li><li>Routines</li><li>Settings</li></ul></nav>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;

    assert.deepEqual(observation.scrollContainers, [
      {
        id: "s1",
        label: "Primary navigation",
        contextPath: [],
        canScrollUp: false,
        canScrollDown: true
      }
    ]);
  } finally {
    await browser.close();
  }
});

void test("prioritizes a blocking alert dialog over an underlying dialog", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        #editor { position: fixed; inset: 20px; z-index: 10; }
        #scrim { position: fixed; inset: 0; z-index: 20; }
        #confirm { position: fixed; top: 80px; left: 80px; z-index: 30; }
      </style>
      <section id="editor" role="dialog" aria-labelledby="editor-title">
        <h2 id="editor-title">Create routine</h2>
        <button>Save routine</button>
      </section>
      <div id="scrim"></div>
      <section id="confirm" role="alertdialog" aria-labelledby="confirm-title">
        <h2 id="confirm-title">Unsaved Changes</h2>
        <button>Continue Editing</button>
        <button>Discard Changes</button>
      </section>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;

    assert.deepEqual(observation.modal, {
      open: true,
      blocksBackground: true,
      role: "alertdialog",
      ariaModal: "",
      title: "Unsaved Changes"
    });
    assert.deepEqual(
      observation.controls.map((control) => [control.label, control.contextPath]),
      [
        ["Continue Editing", ["Unsaved Changes"]],
        ["Discard Changes", ["Unsaved Changes"]]
      ]
    );
  } finally {
    await browser.close();
  }
});

void test("includes named native landmarks in control context", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <nav aria-label="Desktop header"><button>Search</button></nav>
      <aside><nav aria-label="Primary navigation"><a href="/">Home</a></nav></aside>
      <main><button>Enable</button></main>
      <section aria-labelledby="schedule-heading"><span id="schedule-heading">Schedule</span><div role="group" aria-labelledby="schedule-heading"><button>Frequency</button></div></section>
      <footer aria-label="Application status footer"><a href="/privacy">Privacy Policy</a></footer>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;
    const contextFor = (label: string) =>
      observation.controls.find((control) => control.label === label)?.contextPath;

    assert.deepEqual(contextFor("Search"), ["Desktop header"]);
    assert.deepEqual(contextFor("Home"), ["Primary navigation"]);
    assert.deepEqual(contextFor("Enable"), ["main"]);
    assert.deepEqual(contextFor("Frequency"), ["Schedule"]);
    assert.deepEqual(contextFor("Privacy Policy"), ["Application status footer"]);
  } finally {
    await browser.close();
  }
});

void test("keeps a control ID stable when unrelated controls are added", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section role="dialog" aria-modal="true">
        <button id="save">Save schedule</button>
      </section>
    `);

    const firstObservation = (await collectObservation(
      page,
      { maxControls: 10 },
      "t1"
    )) as Observation;
    const firstSave = firstObservation.controls.find(
      (control) => control.label === "Save schedule"
    );

    await page.setContent(`
      <section role="dialog" aria-modal="true">
        <button>Unrelated action</button>
        <button id="save">Save schedule</button>
      </section>
    `);

    const secondObservation = (await collectObservation(
      page,
      { maxControls: 10 },
      "t2"
    )) as Observation;
    const secondSave = secondObservation.controls.find(
      (control) => control.label === "Save schedule"
    );

    assert.match(firstSave?.id || "", /^ctl_[a-z0-9]+(?:_[0-9]+)?$/);
    assert.equal(secondSave?.id, firstSave?.id);
  } finally {
    await browser.close();
  }
});
