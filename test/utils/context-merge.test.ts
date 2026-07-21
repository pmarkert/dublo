import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadContextFromOperations } from "../../src/utils/scenario/context-operations.mjs";

void test("context files merge in order with later top-level values winning", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dublo-context-merge-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));

  const basePath = path.join(directory, "base.yaml");
  const overridePath = path.join(directory, "override.yaml");
  await writeFile(basePath, "email: base@example.test\nregion: us-east-1\n");
  await writeFile(overridePath, "email: override@example.test\nfeature: enabled\n");

  const { contextData } = await loadContextFromOperations([
    { type: "context", value: basePath },
    { type: "context", value: overridePath }
  ]);

  assert.deepEqual(contextData, {
    email: "override@example.test",
    region: "us-east-1",
    feature: "enabled"
  });
});
