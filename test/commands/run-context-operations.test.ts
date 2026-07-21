import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveContextOperations,
  resolveContextSelections,
  resolveInitBlocks
} from "../../src/commands/run/index.js";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("run help exposes repeatable initialization blocks", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "run", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--init <block>/);
  assert.match(result.stdout, /repeatable/);
});

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

void test("resolves repeatable initialization blocks from the workspace", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-init-blocks-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const blocksDirectory = path.join(workspace, "blocks");
  await mkdir(blocksDirectory, { recursive: true });
  await writeFile(
    path.join(blocksDirectory, "login.json"),
    `${JSON.stringify({
      version: 1,
      name: "login",
      actions: [{ reason: "Continue.", payload: { action: "click", target: { id: "a3" } } }]
    })}\n`
  );

  const blocks = await resolveInitBlocks(["login"], workspace);
  assert.deepEqual(
    blocks.map((block) => block.name),
    ["login"]
  );
  assert.deepEqual(blocks[0]?.actions[0]?.payload.target, { id: "a3" });
});
