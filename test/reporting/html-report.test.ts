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
  assert.match(
    html,
    /\.step-action \{ min-width: 0; max-width: 100%; overflow-x: auto; font-weight: 700; white-space: nowrap; \}/
  );
  assert.match(html, /\.raw-json-toggle \{ min-width: 0; max-width: 100%; overflow: hidden;/);
  assert.match(
    html,
    /\.raw-json-toggle pre \{ min-width: 0; max-width: 100%; overflow-x: auto; \}/
  );
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
