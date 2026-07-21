import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("lists, shows, and edits an imported block", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-block-commands-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const blockPath = path.join(workspace, "blocks", "login.json");
  await mkdir(path.dirname(blockPath), { recursive: true });
  await writeFile(blockPath, validBlock("Loading your account"));

  const list = run(["block", "list", "--workspace", workspace]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /Blocks in .+\/blocks:/);
  assert.match(list.stdout, /- login/);

  const show = run(["block", "show", "login", "--workspace", workspace]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`File: ${escapeRegex(blockPath)}`));
  assert.match(show.stdout, /"documentText": "Loading your account"/);

  const updatedBlock = validBlock(["Loading your account", "Still loading your details"]);
  const edit = run(["block", "edit", "login", "--workspace", workspace], updatedBlock);
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, new RegExp(`Wrote ${escapeRegex(blockPath)}`));
  assert.equal(await readFile(blockPath, "utf8"), updatedBlock);
});

void test("validates every saved block and reports malformed files", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-block-commands-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const blocksDir = path.join(workspace, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, "login.json"), validBlock("Loading your account"));
  await writeFile(path.join(blocksDir, "broken.json"), "{not valid JSON\n");

  const result = run(["block", "validate", "--workspace", workspace]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OK {3}login/);
  assert.match(result.stdout, /FAIL broken: Could not read block/);
  assert.match(result.stderr, /One or more blocks are invalid/);
});

void test("validates a manually authored block without source provenance", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-block-commands-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const blocksDir = path.join(workspace, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, "manual.json"), validBlock("Loading your account", false));

  const result = run(["block", "validate", "manual", "--workspace", workspace]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK {3}manual/);
});

function validBlock(documentText: string | string[], includeSource = true): string {
  const source = includeSource ? { source: { runId: "run-1", steps: [2] } } : {};
  return `${JSON.stringify(
    {
      version: 1,
      name: "login",
      ...source,
      actions: [
        {
          reason: "Wait for the loading screen.",
          payload: {
            action: "wait_until_gone",
            expectGone: { documentText }
          }
        }
      ]
    },
    null,
    2
  )}\n`;
}

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
