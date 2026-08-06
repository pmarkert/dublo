import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadScenarioConfig } from "../../src/utils/loadScenarioConfig.js";

void test("loadScenarioConfig preserves environment-backed secret operations", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const config = loadScenarioConfig({
    workspace,
    contextOperations: [{ type: "secret", value: "password=PASSWORD" }]
  });

  assert.deepEqual(config.contextOperations, [{ type: "secret", value: "password=PASSWORD" }]);
});

void test("loadScenarioConfig accepts run-level settling overrides", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const config = loadScenarioConfig({
    workspace,
    settleDelayMs: "650",
    settleTimeoutMs: "5000"
  });

  assert.equal(config.settleDelayMs, 650);
  assert.equal(config.settleTimeoutMs, 5000);
});

void test("loadScenarioConfig lets a run-level max-steps override workspace defaults", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  await writeFile(path.join(workspace, "defaults.json"), '{"maxSteps": 40}\n');

  const config = loadScenarioConfig({ workspace, maxSteps: "12" });

  assert.equal(config.maxSteps, 12);
});

void test("loadScenarioConfig rejects invalid settling overrides", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  assert.throws(
    () => loadScenarioConfig({ workspace, settleDelayMs: "0" }),
    /Expected a positive integer, received '0'/
  );
});

void test("loadScenarioConfig applies a flat test sidecar config before CLI overrides", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const previousMaxSteps = process.env.DUBLO_MAX_STEPS;
  process.env.DUBLO_MAX_STEPS = "50";
  t.after(() => {
    if (previousMaxSteps === undefined) delete process.env.DUBLO_MAX_STEPS;
    else process.env.DUBLO_MAX_STEPS = previousMaxSteps;
  });
  const scenarios = path.join(workspace, "scenarios");
  await mkdir(scenarios, { recursive: true });
  await writeFile(
    path.join(workspace, "defaults.json"),
    '{"maxSteps": 40, "llm": "workspace-model", "context": ["workspace"]}\n'
  );
  await writeFile(path.join(scenarios, "smoke.md"), "Verify the home page.\n");
  await writeFile(
    path.join(scenarios, "smoke.config.json"),
    '{"maxSteps": 60, "llm": "test-model", "context": ["test-context"], "debug": true}\n'
  );

  const sidecarConfig = loadScenarioConfig({ workspace, scenario: "smoke" });
  const config = loadScenarioConfig({ workspace, scenario: "smoke", maxSteps: "12" });

  assert.equal(sidecarConfig.maxSteps, 60);
  assert.equal(config.testConfigPath, path.join(scenarios, "smoke.config.json"));
  assert.equal(config.maxSteps, 12);
  assert.equal(config.llmRef, "test-model");
  assert.equal(config.debug, true);
  assert.deepEqual(config.testContextRefs, ["test-context"]);
  assert.deepEqual(config.workspaceContextRefs, ["workspace"]);
});

void test("loadScenarioConfig ignores sidecar configs for built-in and direct-file tests", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const directScenario = path.join(workspace, "direct.md");
  await writeFile(directScenario, "Verify the home page.\n");

  const config = loadScenarioConfig({ workspace, scenario: directScenario });

  assert.equal(config.testConfigPath, "");
});

void test("loadScenarioConfig loads a sidecar for an inferred single test profile", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const scenarios = path.join(workspace, "scenarios");
  await mkdir(scenarios, { recursive: true });
  await writeFile(path.join(scenarios, "smoke.md"), "Verify the home page.\n");
  await writeFile(path.join(scenarios, "smoke.config.json"), '{"maxSteps":60}\n');

  const config = loadScenarioConfig({ workspace });

  assert.equal(config.maxSteps, 60);
  assert.equal(config.testConfigPath, path.join(scenarios, "smoke.config.json"));
});
