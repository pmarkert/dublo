import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
