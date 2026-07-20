import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
