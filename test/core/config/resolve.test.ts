import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import { resolveWorkspaceConfig } from "../../../src/core/config/resolve.js";

test("resolves workspace configuration with CLI precedence", () => {
  const result = resolveWorkspaceConfig({
    cli: { baseUrl: "https://cli.example.test", maxSteps: 9 },
    environment: {
      DUBLO_BASE_URL: "https://environment.example.test",
      DUBLO_MAX_STEPS: "8"
    },
    workspace: { baseUrl: "https://workspace.example.test", maxSteps: 7 }
  });

  assert.equal(result.values.baseUrl, "https://cli.example.test");
  assert.equal(result.values.maxSteps, 9);
  assert.equal(result.sources.baseUrl, "cli");
  assert.equal(result.sources.maxSteps, "cli");
});

test("resolves environment before workspace and built-in defaults", () => {
  const result = resolveWorkspaceConfig({
    environment: {
      DUBLO_BASE_URL: "https://environment.example.test",
      DUBLO_HEADLESS: "yes",
      DUBLO_REPORTS: "none"
    },
    workspace: { baseUrl: "https://workspace.example.test", maxSteps: 7 }
  });

  assert.equal(result.values.baseUrl, "https://environment.example.test");
  assert.equal(result.sources.baseUrl, "environment");
  assert.equal(result.values.maxSteps, 7);
  assert.equal(result.sources.maxSteps, "workspace");
  assert.equal(result.values.headless, true);
  assert.deepEqual(result.values.reports, []);
  assert.equal(result.values.outputDir, "./reports");
  assert.equal(result.sources.debug, "built-in");
});

test("rejects unknown workspace configuration keys", () => {
  assert.throws(
    () => resolveWorkspaceConfig({ workspace: { unexpected: true } }),
    ZodError
  );
});