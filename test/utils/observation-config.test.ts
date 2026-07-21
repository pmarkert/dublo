import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadObservationConfig,
  normalizeScreenshotMode
} from "../../src/utils/scenario/observation-config.mjs";

void test("loads default observation configuration and normalizes screenshot modes", async () => {
  const config = (await loadObservationConfig()) as Record<string, unknown>;

  assert.equal(config.maxControls, 80);
  assert.deepEqual(config.documentTextScopeSelectors, ["main", "[role='main']"]);
  assert.equal(normalizeScreenshotMode("full-page"), "fullpage");
  assert.equal(normalizeScreenshotMode("VIEWPORT"), "viewport");
  assert.equal(normalizeScreenshotMode("unknown"), "none");
});

void test("merges an observation configuration file while replacing array values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dublo-observation-config-"));
  const configPath = path.join(directory, "observation.json");
  await writeFile(
    configPath,
    JSON.stringify({ maxControls: 12, ignoreControlSelectors: ["[data-test='ignore']"] })
  );

  const config = (await loadObservationConfig(configPath)) as Record<string, unknown>;

  assert.equal(config.maxControls, 12);
  assert.deepEqual(config.ignoreControlSelectors, ["[data-test='ignore']"]);
  assert.equal(config.maxHeadings, 10);
});
