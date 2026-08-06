import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("test config edit, show, and validate manage a flat scenario sidecar", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-test-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  const scenarios = path.join(workspace, "scenarios");
  const configPath = path.join(scenarios, "checkout.config.json");
  await mkdir(scenarios, { recursive: true });
  await writeFile(path.join(scenarios, "checkout.md"), "Complete checkout.\n");

  const edit = run(["test", "config", "edit", "checkout", "--workspace", workspace], '{"llm":"fast","maxSteps":60}\n');
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, new RegExp(`Wrote ${escapeRegex(configPath)}`));
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { llm: "fast", maxSteps: 60 });

  const show = run(["test", "config", "show", "checkout", "--workspace", workspace]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`File: ${escapeRegex(configPath)}`));
  assert.match(show.stdout, /"maxSteps": 60/);

  const validate = run(["test", "config", "validate", "checkout", "--workspace", workspace]);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /OK   checkout/);
});

void test("test config requires an existing workspace scenario profile", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-test-config-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const result = run(["test", "config", "edit", "missing", "--workspace", workspace], "{}\n");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not resolve workspace test profile 'missing'/);
});

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