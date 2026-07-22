import assert from "node:assert/strict";
import test from "node:test";
import { reportGenerator } from "../../src/reporting/html-report.mjs";

void test("renders ordered debug step details including the exact agent prompt and priced token usage", () => {
  const html = reportGenerator.render({
    context: {
      config: { baseUrl: "https://example.com" },
      modelSummary: "test/model",
      runId: "run-1",
      scenario: "Sign in",
      screenshots: "none"
    },
    report: {
      finalUrl: "https://example.com/home",
      status: "passed",
      steps: [
        {
          durationMs: 123,
          index: 1,
          name: "fill_a2",
          plannerAction: {
            reason: "Enter the email address to sign in.",
            payload: { action: "fill", target: { id: "a2" } }
          },
          screenshot: "screenshots/01-fill_a2.png",
          observation: {
            url: "https://example.com/login",
            title: "Sign in",
            modal: {},
            headings: [],
            alerts: [],
            documentText: "Sign in",
            scrollContainers: [],
            controls: []
          },
          agentPrompt: {
            userText: "# Current Turn: Authoritative State\n\n## Currently Actionable Controls"
          },
          ariaSnapshot: "- main:\n  - button \"Save & continue\"",
          plannerTokenUsage: {
            inputTokens: 1_000,
            outputTokens: 250,
            totalTokens: 1_250,
            cacheReadInputTokens: 50,
            cacheWriteInputTokens: 10
          },
          url: "https://example.com/login"
        }
      ],
      agentSystemPrompt: "# Role\nYou are a UX test agent.",
      pricing: {
        currency: "USD",
        tokenUnit: 1_000,
        inputUsdPerUnit: 1,
        outputUsdPerUnit: 2,
        cacheReadUsdPerUnit: 0.5,
        cacheWriteUsdPerUnit: 0.25
      }
    }
  });

  assert.match(
    html,
    /<span class="step-action">fill target=\{&quot;id&quot;:&quot;a2&quot;\}<\/span>/
  );
  assert.match(
    html,
    /<span class="step-url"><a href="https:\/\/example\.com\/login">\/login<\/a><\/span>/
  );
  assert.match(html, /<span class="step-duration">123ms<\/span>/);
  assert.match(
    html,
    /<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-external-link"><\/use><\/svg><span>Open \/login<\/span>/
  );
  assert.match(html, /<symbol id="icon-image" viewBox="0 0 24 24"/);
  assert.match(html, /<symbol id="icon-link" viewBox="0 0 24 24"/);
  assert.match(html, /<span class="step-reason">Enter the email address to sign in\.<\/span>/);
  assert.match(html, /<h4>Resulting Screenshot<\/h4>/);
  assert.match(html, /<h4>Observation<\/h4>/);
  assert.match(html, /<h4>ARIA Snapshot<\/h4>/);
  assert.match(html, /- main:\n\s{2}- button &quot;Save &amp; continue&quot;/);
  assert.match(html, /role="group" aria-label="Observation view" data-observation-toggle/);
  assert.match(
    html,
    /aria-controls="step-1-observation-ui" aria-pressed="true" data-observation-view="ui">UI/
  );
  assert.match(html, /id="step-1-observation-raw" data-observation-panel="raw" hidden/);
  assert.match(html, /data-observation-toggle/);
  assert.match(html, /\.observation \[hidden\] \{ display: none !important; \}/);
  assert.match(html, /color-scheme: light dark/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /main \{ width: calc\(100% - 48px\);/);
  assert.match(html, /overflow-wrap: anywhere; word-break: break-word;/);
  assert.match(html, /<h4>Agent Prompt<\/h4>/);
  assert.match(html, /You are a UX test agent\./);
  assert.match(html, /<details class="card prompt system-prompt"><summary><h2>Agent System Prompt<\/h2><\/summary>/);
  assert.match(html, /\.system-prompt summary h2 \{ display: inline; margin: 0; \}/);
  assert.match(html, /# Role\nYou are a UX test agent\./);
  assert.match(html, /# Current Turn: Authoritative State/);
  assert.match(html, /<h4>Token Usage<\/h4>/);
  assert.match(html, /Estimated Cost<\/span><strong>1\.527500 USD/);
  assert.match(html, /role="tablist" aria-label="Step 1 details" data-step-tabs/);
  assert.match(html, /role="tab" id="step-1-tab-action"/);
  assert.match(html, /role="tab" id="step-1-tab-aria-snapshot"/);
  assert.match(html, /aria-controls="step-1-tab-panel-observation"/);
  assert.match(html, /role="tabpanel" id="step-1-tab-panel-action"/);
  assert.match(html, /id="step-1-tab-panel-screenshot"[^>]* hidden/);
  assert.match(html, /event\.key === "ArrowRight"/);
  assert.ok(
    html.indexOf("<h4>Planner Action</h4>") < html.indexOf("<h4>Resulting Screenshot</h4>") &&
      html.indexOf("<h4>Resulting Screenshot</h4>") < html.indexOf("<h4>Observation</h4>") &&
    html.indexOf("<h4>Observation</h4>") < html.indexOf("<h4>ARIA Snapshot</h4>") &&
    html.indexOf("<h4>ARIA Snapshot</h4>") < html.indexOf("<h4>Agent Prompt</h4>") &&
      html.indexOf("<h4>Agent Prompt</h4>") < html.indexOf("<h4>Token Usage</h4>")
  );
  assert.ok(html.indexOf("<h2>Agent System Prompt</h2>") < html.indexOf("<h2>Steps</h2>"));
  assert.doesNotMatch(html, /<span class="step-name">fill_a2<\/span>/);
  assert.match(html, /<details class="step-card" id="step-1">/);
  assert.match(
    html,
    /<a class="step-anchor" href="#step-1" aria-label="Link to step 1"><svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-link"><\/use><\/svg><\/a>/
  );
  assert.match(html, /<span class="step-caret" aria-hidden="true"><\/span>/);
  assert.match(html, /\.step-card \{ min-width: 0; max-width: 100%; \}/);
  assert.match(html, /grid-template-columns: auto auto auto minmax\(0, 1fr\) minmax\(120px, auto\) auto/);
  assert.match(html, /\.step-card\[open\] \.step-caret \{ transform: rotate\(90deg\); \}/);
  assert.match(
    html,
    /\.step-action \{ min-width: 0; max-width: 100%; overflow-wrap: anywhere; font-weight: 700; \}/
  );
  assert.match(
    html,
    /\.image-link img \{ display: block; width: auto; max-width: 100%; height: auto; border-radius: 6px;/
  );
  assert.match(
    html,
    /\.raw-observation pre \{ min-width: 0; max-width: 100%; overflow-x: auto; \}/
  );
  assert.match(html, /\.step-tabs \[role="tabpanel"\] \{ min-width: 0; max-width: 100%; \}/);
  assert.match(
    html,
    /\.step-tabs \[role="tabpanel"\] pre \{ min-width: 0; max-width: 100%; overflow-x: auto; \}/
  );
});

void test("promotes the system prompt from older debug steps when rerendering", () => {
  const html = reportGenerator.render({
    context: {
      config: { baseUrl: "https://example.com" },
      modelSummary: "test/model",
      runId: "run-1",
      scenario: "Sign in",
      screenshots: "none"
    },
    report: {
      finalUrl: "https://example.com/home",
      status: "passed",
      steps: [
        {
          durationMs: 10,
          index: 1,
          name: "finish",
          agentPrompt: { systemText: "Older shared system prompt.", userText: "Current turn." },
          url: "https://example.com/home"
        }
      ]
    }
  });

  assert.match(html, /<details class="card prompt system-prompt"><summary><h2>Agent System Prompt<\/h2><\/summary>/);
  assert.match(html, /Older shared system prompt\./);
  assert.ok(html.indexOf("<h2>Agent System Prompt</h2>") < html.indexOf("<h2>Steps</h2>"));
});
