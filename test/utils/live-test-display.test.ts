import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTestDisplay } from "../../src/utils/live-test-display.mjs";

void test("live test display redraws a compact test state without input values", () => {
  const writes: string[] = [];
  const output = {
    columns: 100,
    isTTY: true,
    write: (value: string) => writes.push(value)
  };
  let timestamp = 0;
  const display = createLiveTestDisplay({ output, now: () => timestamp });

  display.start({
    objective: "Sign in and open routines.",
    baseUrl: "https://example.test",
    provider: "bedrock:test-model",
    maxSteps: 20
  });
  timestamp = 65_000;
  display.observe(
    {
      title: "Sign in",
      url: "https://example.test/login",
      tree: [
        { kind: "heading", text: "Sign in" },
        { kind: "control", id: "email", label: "Email", value: "private@example.test" },
        { kind: "control", id: "continue", label: "Continue", text: "Continue" }
      ]
    },
    2
  );
  display.action({
    reason: "Continue after entering the email address.",
    payload: { action: "click", target: { id: "continue" } }
  });
  display.finish("passed");

  const screen = writes.at(-1) || "";
  assert.match(screen, /^\u001B\[H\u001B\[2JDUBLO TEST  PASSED/m);
  assert.match(screen, /Planner steps: 2\/20  \|  Elapsed: 00:01:05/);
  assert.match(screen, /Last action: click continue - Continue after entering the email address\./);
  assert.match(screen, /Title: Sign in/);
  assert.match(screen, /Visible: Sign in \| Email \| Continue/);
  assert.doesNotMatch(screen, /private@example\.test/);
});

void test("live test display does not write when terminal rendering is disabled", () => {
  const writes: string[] = [];
  const display = createLiveTestDisplay({
    enabled: false,
    output: { isTTY: false, write: (value: string) => writes.push(value) }
  });

  display.start({ objective: "Test", baseUrl: "https://example.test", provider: "model", maxSteps: 1 });
  display.finish("passed");

  assert.deepEqual(writes, []);
});