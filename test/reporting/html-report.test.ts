import assert from "node:assert/strict";
import test from "node:test";
import { reportGenerator } from "../../src/reporting/html-report.mjs";

void test("renders action, URL, duration, and reason in each step header", () => {
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
          url: "https://example.com/login"
        }
      ]
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
  assert.match(html, /<span class="step-reason">Enter the email address to sign in\.<\/span>/);
  assert.doesNotMatch(html, /<span class="step-name">fill_a2<\/span>/);
  assert.match(html, /\.step-card \{ min-width: 0; max-width: 100%; \}/);
  assert.match(html, /grid-template-columns: auto minmax\(0, 1fr\) minmax\(120px, auto\) auto/);
  // Long action/target names wrap instead of forcing a horizontal scrollbar.
  assert.match(
    html,
    /\.step-action \{ min-width: 0; max-width: 100%; font-weight: 700; overflow-wrap: anywhere; \}/
  );
  assert.match(html, /\.status-row strong, \.meta-grid strong[^{]*\{ overflow-wrap: anywhere; \}/);
  assert.match(html, /\.raw-json-toggle \{ min-width: 0; max-width: 100%; overflow: hidden;/);
  assert.match(
    html,
    /\.raw-json-toggle pre \{ min-width: 0; max-width: 100%; overflow-x: auto; \}/
  );
});

void test("renders escalation, repair steps, shared observations, and split cost", () => {
  const html = reportGenerator.render({
    context: {
      config: { baseUrl: "https://example.com" },
      modelSummary: "bedrock/amazon.nova-lite-v1:0",
      runId: "run-3",
      scenario: "Sign up",
      screenshots: "none"
    },
    report: {
      finalUrl: "https://example.com/home",
      status: "passed",
      costEstimate: {
        currency: "USD",
        tokenUnit: 1000000,
        rates: {
          inputUsdPerUnit: 0.06,
          outputUsdPerUnit: 0.24,
          cacheReadUsdPerUnit: 0,
          cacheWriteUsdPerUnit: 0
        },
        costs: { input: 0.011, output: 0.021, cacheRead: 0, cacheWrite: 0, total: 0.032 },
        primary: { costs: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
        escalation: {
          modelId: "anthropic.claude-sonnet-4-5",
          rates: {
            inputUsdPerUnit: 3,
            outputUsdPerUnit: 15,
            cacheReadUsdPerUnit: 0,
            cacheWriteUsdPerUnit: 0
          },
          costs: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 }
        }
      },
      steps: [
        {
          durationMs: 0,
          index: 1,
          name: "planner_invalid_turn",
          phase: "planner_repair",
          plannerModel: "amazon.nova-lite-v1:0",
          retriedWith: "amazon.nova-lite-v1:0",
          outcome: "error",
          error: "actions.0.value: expected string",
          url: "https://example.com/signup"
        },
        {
          durationMs: 80,
          index: 2,
          name: "fill_a2",
          plannerModel: "anthropic.claude-sonnet-4-5",
          escalated: true,
          escalationReason: "invalid planner turn persisted after one retry",
          plannerAction: {
            reason: "Fill the email field.",
            payload: { action: "fill", target: { id: "a2" } }
          },
          url: "https://example.com/signup"
        },
        {
          durationMs: 20,
          index: 3,
          name: "batch_fill_3",
          phase: "batch",
          observationSharedFromStep: 2,
          plannerAction: {
            reason: "Fill the email field.",
            payload: { action: "fill", target: { id: "a3" } }
          },
          url: "https://example.com/signup"
        }
      ]
    }
  });

  // Repair step is its own entry with the failure and the retry target.
  assert.match(html, /invalid turn/);
  assert.match(html, /retried with amazon\.nova-lite-v1:0/);
  assert.match(html, /actions\.0\.value: expected string/);
  // Escalated step names the model and the reason.
  assert.match(html, /class="mini-pill mini-pill-escalated"/);
  assert.match(html, /invalid planner turn persisted after one retry/);
  assert.match(html, /anthropic\.claude-sonnet-4-5/);
  // Batch follow-on links back to the shared observation's step.
  assert.match(html, /id="step-2"/);
  assert.match(html, /<a href="#step-2">step 2<\/a>/);
  // Cost summary splits primary vs escalation.
  assert.match(html, /Primary Model<\/span><strong>0\.030000 USD/);
  assert.match(html, /Escalation \(anthropic\.claude-sonnet-4-5\)<\/span><strong>0\.002000 USD/);
});

void test("renders reported findings and per-step runtime signals", () => {
  const html = reportGenerator.render({
    context: {
      config: { baseUrl: "https://example.com" },
      modelSummary: "test/model",
      runId: "run-2",
      scenario: "Explore",
      screenshots: "none"
    },
    report: {
      finalUrl: "https://example.com/home",
      status: "passed",
      findings: [
        {
          step: 3,
          url: "https://example.com/cart",
          severity: "major",
          category: "accessibility",
          summary: "Remove button has no accessible name.",
          evidence: "Icon-only button with no label.",
          reason: "Screen reader users cannot identify the control."
        }
      ],
      steps: [
        {
          durationMs: 50,
          index: 3,
          name: "click_a5",
          plannerAction: {
            reason: "Open cart.",
            payload: { action: "click", target: { id: "a5" } }
          },
          url: "https://example.com/cart",
          runtimeErrors: [
            { type: "response", status: 500, method: "GET", url: "https://api.example.com/cart" }
          ]
        }
      ]
    }
  });

  assert.match(html, /<h2>Findings \(1\)<\/h2>/);
  assert.match(html, /finding finding-major/);
  assert.match(html, /Remove button has no accessible name\./);
  assert.match(html, /<h4>Runtime Signals<\/h4>/);
  assert.match(html, /response · 500 · GET · https:\/\/api\.example\.com\/cart/);
});
