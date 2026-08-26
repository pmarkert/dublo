import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeBrowserAction,
  resolveSameOriginUrl
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
