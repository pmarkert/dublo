import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigWizardPrompts } from "../../src/cli/config-wizard.js";
import { runConfigWizard } from "../../src/cli/config-wizard.js";

void test("configuration wizard persists only choices that differ from built-ins", async () => {
  const output: string[] = [];
  const promptsSeen: string[] = [];
  const prompts: ConfigWizardPrompts = {
    input: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(
        {
          "Base URL": "https://app.example.test",
          "Output directory": "artifacts/reports"
        }[message] ?? defaultValue
      );
    },
    number: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(defaultValue);
    },
    confirm: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(message === "Run browsers headlessly" ? true : defaultValue);
    },
    select: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(
        {
          "Default persona": "qa",
          Screenshots: "fullpage"
        }[message] ?? defaultValue
      );
    },
    checkbox: ({ message }) => {
      promptsSeen.push(message);
      return Promise.resolve(
        message === "Default context profiles" ? ["checkout", "account"] : ["html"]
      );
    }
  };

  const defaults = await runConfigWizard({
    current: {},
    profiles: {
      llm: [],
      persona: [
        { name: "No default persona", value: "" },
        { name: "Built-in: qa", value: "qa" }
      ],
      context: [
        { name: "checkout", value: "checkout" },
        { name: "account", value: "account" }
      ]
    },
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
  assert.equal(promptsSeen.includes("Default LLM profile"), false);
  assert.equal(promptsSeen.includes("Default context profiles"), true);
  assert.match(output.join(""), /arrow keys, and space/);
});

void test("configuration wizard omits unavailable profiles while offering built-in personas", async () => {
  const promptsSeen: string[] = [];
  let personaChoices: readonly string[] = [];
  const prompts: ConfigWizardPrompts = {
    input: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(defaultValue);
    },
    number: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(defaultValue);
    },
    confirm: ({ message, default: defaultValue }) => {
      promptsSeen.push(message);
      return Promise.resolve(defaultValue);
    },
    select: ({ message, choices, default: defaultValue }) => {
      promptsSeen.push(message);
      if (message === "Default persona") personaChoices = choices.map((choice) => choice.value);
      return Promise.resolve(defaultValue);
    },
    checkbox: ({ message }) => {
      promptsSeen.push(message);
      return Promise.resolve(["markdown", "html"]);
    }
  };

  const defaults = await runConfigWizard({
    current: {},
    profiles: {
      llm: [],
      persona: [
        { name: "No default persona", value: "" },
        { name: "Built-in: qa-strict", value: "qa-strict" }
      ],
      context: []
    },
    prompts,
    write: () => undefined
  });

  assert.deepEqual(defaults, {});
  assert.equal(promptsSeen.includes("Default LLM profile"), false);
  assert.equal(promptsSeen.includes("Default context profiles"), false);
  assert.deepEqual(personaChoices, ["", "qa-strict"]);
});
