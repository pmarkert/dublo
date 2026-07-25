import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { collectObservation } from "../../src/utils/scenario/observation.mjs";

type ObservationNode = {
  kind: string;
  id?: string;
  name?: string;
  title?: string;
  text?: string;
  label?: string;
  role?: string;
  tag?: string;
  type?: string;
  priority?: boolean;
  order?: number;
  blocking?: boolean;
  canScrollUp?: boolean;
  canScrollDown?: boolean;
  checked?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  children?: ObservationNode[];
};

type Observation = {
  activeDialog?: {
    blocking: boolean;
    role: string;
    title: string;
  };
  tree: ObservationNode[];
};

function flattenTree(nodes: ObservationNode[]): ObservationNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children || [])]);
}

function contextPathForControl(nodes: ObservationNode[], label: string, path: string[] = []): string[] | undefined {
  for (const node of nodes) {
    const nextPath = node.kind === "context" && node.name ? [...path, node.name] : path;
    if (node.kind === "control" && node.label === label) return path;
    const result = contextPathForControl(node.children || [], label, nextPath);
    if (result) return result;
  }
  return undefined;
}

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

    assert.deepEqual(observation.activeDialog, {
      blocking: true,
      role: "dialog",
      title: "Schedule"
    });
    const nodes = flattenTree(observation.tree);
    assert.equal(
      nodes.some((node) => node.kind === "control" && node.label === "Background action"),
      false
    );
    assert.equal(
      nodes.some((node) => node.kind === "control" && node.label === "Save schedule"),
      true
    );
    assert.equal(
      nodes.some(
        (node) => node.kind === "control" && node.role === "option" && node.text === "Weekdays" && node.priority
      ),
      true
    );
    assert.equal(
      nodes.some((node) => node.kind === "control" && node.label === "Offscreen action"),
      true
    );
    assert.equal(
      nodes.some((node) => node.kind === "scroll" && node.canScrollDown),
      true
    );
    const scroll = observation.tree[0]?.children?.find((node) => node.kind === "scroll");
    assert.deepEqual(
      { id: scroll?.id, label: scroll?.label, canScrollUp: scroll?.canScrollUp, canScrollDown: scroll?.canScrollDown },
      { id: "s1", label: "Schedule form", canScrollUp: false, canScrollDown: true }
    );
    assert.equal(
      flattenTree(scroll?.children || []).some(
        (node) => node.kind === "control" && node.label === "Visible form action"
      ),
      true
    );
    assert.equal(
      nodes.some((node) => node.kind === "control" && node.label === "Close dialog"),
      true
    );
    assert.equal(
      flattenTree(scroll?.children || []).some(
        (node) => node.kind === "control" && node.label === "Close dialog"
      ),
      false
    );
    assert.equal(nodes.some((node) => node.kind === "heading" && node.text === "Schedule"), true);
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

    const scroll = observation.tree[0];
    assert.deepEqual(
      { kind: scroll?.kind, id: scroll?.id, label: scroll?.label, canScrollUp: scroll?.canScrollUp, canScrollDown: scroll?.canScrollDown },
      { kind: "scroll", id: "s1", label: "Primary navigation", canScrollUp: false, canScrollDown: true }
    );
  } finally {
    await browser.close();
  }
});

void test("captures text in the observation tree without hidden content", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        #scroll-area { height: 70px; overflow-y: auto; }
        #scroll-content { height: 180px; }
        #offscreen { margin-top: 100px; }
        #hidden { display: none; }
      </style>
      <main>
        <p id="visible">Visible instructions for this routine.</p>
        <p id="hidden">Hidden implementation detail.</p>
        <div id="scroll-area"><div id="scroll-content"><p id="offscreen">Additional schedule guidance below.</p></div></div>
      </main>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;
    const nodes = flattenTree(observation.tree);

    assert.deepEqual(
      nodes.filter((node) => node.kind === "text").map((node) => node.text),
      ["Visible instructions for this routine.", "Additional schedule guidance below."]
    );
    assert.equal(
      nodes.some((node) => node.text?.includes("Hidden implementation detail")),
      false
    );
  } finally {
    await browser.close();
  }
});

void test("keeps a non-blocking dialog in its own context alongside page content", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main><h1>Routines</h1><button>Add routine</button></main>
      <aside role="dialog" aria-labelledby="tutorial-title">
        <h2 id="tutorial-title">Routines tutorial</h2>
        <p>Learn how routines work.</p>
        <button>Skip tutorial</button>
      </aside>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;
    const nodes = flattenTree(observation.tree);

    assert.deepEqual(observation.activeDialog, {
      blocking: false,
      role: "dialog",
      title: "Routines tutorial"
    });
    assert.deepEqual(
      nodes.filter((node) => node.kind === "control").map((node) => node.label),
      [
        "Add routine",
        "Skip tutorial"
      ]
    );
    assert.equal(nodes.some((node) => node.kind === "text" && node.text === "Learn how routines work."), true);
    const addRoutine = nodes.find((node) => node.kind === "control" && node.label === "Add routine");
    const skipTutorial = nodes.find((node) => node.kind === "control" && node.label === "Skip tutorial");
    assert.deepEqual(observation.tree, [
      {
        kind: "context",
        name: "main",
        children: [
          { kind: "heading", text: "Routines", level: 1 },
          { kind: "control", id: addRoutine?.id, tag: "button", text: "Add routine", label: "Add routine" }
        ]
      },
      {
        kind: "dialog",
        role: "dialog",
        title: "Routines tutorial",
        blocking: false,
        children: [
          { kind: "heading", text: "Routines tutorial", level: 2 },
          { kind: "text", text: "Learn how routines work." },
          { kind: "control", id: skipTutorial?.id, tag: "button", text: "Skip tutorial", label: "Skip tutorial" }
        ]
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

    assert.deepEqual(observation.activeDialog, {
      blocking: true,
      role: "alertdialog",
      title: "Unsaved Changes"
    });
    assert.deepEqual(
      flattenTree(observation.tree).filter((node) => node.kind === "control").map((node) => node.label),
      ["Continue Editing", "Discard Changes"]
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
    const contextFor = (label: string) => contextPathForControl(observation.tree, label);

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
    const firstSave = flattenTree(firstObservation.tree).find(
      (node) => node.kind === "control" && node.label === "Save schedule"
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
    const secondSave = flattenTree(secondObservation.tree).find(
      (node) => node.kind === "control" && node.label === "Save schedule"
    );

    assert.match(firstSave?.id || "", /^ctl_[a-z0-9]+(?:_[0-9]+)?$/);
    assert.equal(secondSave?.id, firstSave?.id);
  } finally {
    await browser.close();
  }
});

void test("omits blank control fields while retaining explicit checkable state", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent('<button></button><input type="checkbox"><button aria-expanded="false">Menu</button>');

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;
    const nodes = flattenTree(observation.tree);
    const blankButton = nodes.find((node) => node.kind === "control" && node.tag === "button" && !node.text);
    const checkbox = nodes.find((node) => node.kind === "control" && node.type === "checkbox");
    const collapsedButton = nodes.find((node) => node.kind === "control" && node.text === "Menu");

    assert.deepEqual(blankButton, { kind: "control", id: blankButton?.id, tag: "button" });
    assert.equal("checked" in (checkbox || {}), true);
    assert.equal((checkbox as { checked?: boolean } | undefined)?.checked, false);
    assert.equal((collapsedButton as { expanded?: boolean } | undefined)?.expanded, false);
  } finally {
    await browser.close();
  }
});

void test("retains disabled controls and excludes nested semantic text in DOM order", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <h1>Bonsai<span>360</span></h1>
      <main>
        <h2>Get Started</h2>
        <form><input aria-label="Email or username"><button disabled>Continue with email or username</button></form>
      </main>
      <footer><p>© 2026 Bonsai360. All rights reserved. <a href="/privacy">Privacy Policy</a></p></footer>
    `);

    const observation = (await collectObservation(page, { maxControls: 10 }, "t1")) as Observation;
    const nodes = flattenTree(observation.tree);
    const textNodes = nodes.filter((node) => node.kind === "text").map((node) => node.text);
    const controls = nodes.filter((node) => node.kind === "control");
    const submit = controls.find((node) => node.label === "Continue with email or username");

    assert.equal(submit?.disabled, true);
    assert.equal(textNodes.includes("360"), false);
    assert.equal(textNodes.includes("© 2026 Bonsai360. All rights reserved. Privacy Policy"), false);
    assert.equal(textNodes.includes("© 2026 Bonsai360. All rights reserved."), true);
    assert.equal(controls.some((node) => node.label === "Privacy Policy"), true);
    assert.deepEqual(
      observation.tree.map((node) => node.kind === "context" ? node.name : node.text),
      ["Bonsai360", "main", "contentinfo"]
    );
  } finally {
    await browser.close();
  }
});
