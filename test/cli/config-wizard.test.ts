import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigWizardPrompts } from "../../src/cli/config-wizard.js";
import { runConfigWizard } from "../../src/cli/config-wizard.js";

void test("configuration wizard persists only choices that differ from built-ins", async () => {
  const output: string[] = [];
  const prompts: ConfigWizardPrompts = {
    input: ({ message, default: defaultValue }) =>
      Promise.resolve(
        {
          "Base URL": "https://app.example.test",
          "Default persona profile": "qa",
          "Default context profiles/files (comma-separated)": "checkout, account",
          "Output directory": "artifacts/reports"
        }[message] ?? defaultValue
      ),
    number: ({ default: defaultValue }) => Promise.resolve(defaultValue),
    confirm: ({ message, default: defaultValue }) =>
      Promise.resolve(message === "Run browsers headlessly" ? true : defaultValue),
    select: ({ default: defaultValue }) =>
      Promise.resolve(defaultValue === "none" ? "fullpage" : defaultValue),
    checkbox: () => Promise.resolve(["html"])
  };

  const defaults = await runConfigWizard({
    current: {},
    prompts,
    write: (text) => output.push(text)
  });

  assert.deepEqual(defaults, {
    baseUrl: "https://app.example.test",
    persona: "qa",
    context: ["checkout", "account"],
    headless: true,
    screenshots: "fullpage",
    reports: ["html"],
    outputDir: "artifacts/reports"
  });
  assert.match(output.join(""), /arrow keys, and space/);
});
