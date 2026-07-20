import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initialContextProfileContent } from "../../src/commands/context/edit.js";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("context edit creates YAML for a new profile without a format selection", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-context-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "context", "edit", "checkout", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8", input: "cart:\n  items: 1\n" }
  );

  assert.equal(result.status, 0, result.stderr);
  const profilePath = path.join(workspace, "context", "checkout.yaml");
  assert.match(result.stdout, new RegExp(profilePath));
  assert.equal(await readFile(profilePath, "utf8"), "cart:\n  items: 1\n");
});

void test("new YAML context profiles start with an instructional comment", () => {
  assert.equal(initialContextProfileContent("checkout.yaml"), "# YAML or JSON data\n");
  assert.equal(initialContextProfileContent("checkout.yml"), "# YAML or JSON data\n");
  assert.equal(initialContextProfileContent("checkout.json"), "{}\n");
});

void test("context show treats a comment-only YAML template as an empty object", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-context-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  await mkdir(path.join(workspace, "context"), { recursive: true });
  await writeFile(path.join(workspace, "context", "gary.yaml"), "# YAML or JSON data.\n");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "context", "show", "gary", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
});
