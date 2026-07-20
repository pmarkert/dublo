import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveContextOperations,
  resolveContextSelections
} from "../../src/commands/run/index.js";

void test("context selections combine sources in last-wins precedence order", () => {
  const selections = resolveContextSelections({
    workspaceContextRefs: ["base", "workspace-overrides"],
    environmentContextRefs: ["environment-overrides"],
    cliContextRefs: ["cli-overrides"]
  });

  assert.deepEqual(selections, [
    "base",
    "workspace-overrides",
    "environment-overrides",
    "cli-overrides"
  ]);
});

void test("inline secret operations retain configured context files", () => {
  const operations = resolveContextOperations({
    contextFiles: ["/workspace/context/gary.yaml"],
    contextOperations: [{ type: "secret", value: "password=PASSWORD" }]
  });

  assert.deepEqual(operations, [
    { type: "context", value: "/workspace/context/gary.yaml" },
    { type: "secret", value: "password=PASSWORD" }
  ]);
});

void test("ordered inline operations are not duplicated from legacy option arrays", () => {
  const operations = resolveContextOperations({
    contextFiles: ["/workspace/context/gary.yaml"],
    contextOperations: [{ type: "set", value: "retries=3" }],
    setEntries: ["retries=3"]
  });

  assert.deepEqual(operations, [
    { type: "context", value: "/workspace/context/gary.yaml" },
    { type: "set", value: "retries=3" }
  ]);
});

void test("explicit context operations retain inherited context files", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-context-operations-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const contextDirectory = path.join(workspace, "context");
  const basePath = path.join(contextDirectory, "base.yaml");
  const cliPath = path.join(contextDirectory, "cli.yaml");
  await mkdir(contextDirectory, { recursive: true });
  await Promise.all([writeFile(basePath, "base: true\n"), writeFile(cliPath, "cli: true\n")]);

  const operations = resolveContextOperations({
    workspace,
    inheritedContextFiles: [basePath],
    contextFiles: [basePath, cliPath],
    contextOperations: [{ type: "context", value: "cli" }]
  });

  assert.deepEqual(operations, [
    { type: "context", value: basePath },
    { type: "context", value: cliPath }
  ]);
});
