import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStore } from "../../src/node/workspace-store.js";

void test("workspace store creates and persists validated workspace defaults", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dublo-workspace-store-"));
  t.after(async () => rm(temporaryDirectory, { force: true, recursive: true }));

  const store = createWorkspaceStore({ cwd: temporaryDirectory });
  const workspace = store.resolve();

  await store.ensure(workspace);
  await store.writeDefaults(workspace, {
    baseUrl: "https://example.test",
    maxSteps: 12,
    reports: ["html"]
  });

  assert.deepEqual(await store.readDefaults(workspace), {
    baseUrl: "https://example.test",
    maxSteps: 12,
    reports: ["html"]
  });
  assert.equal(
    await readFile(path.join(workspace, "defaults.json"), "utf8"),
    '{\n  "baseUrl": "https://example.test",\n  "maxSteps": 12,\n  "reports": [\n    "html"\n  ]\n}\n'
  );
});

void test("workspace store treats a missing defaults file as an empty workspace configuration", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dublo-workspace-store-"));
  t.after(async () => rm(temporaryDirectory, { force: true, recursive: true }));

  const store = createWorkspaceStore({ cwd: temporaryDirectory });
  assert.deepEqual(await store.readDefaults(store.resolve()), {});
});
