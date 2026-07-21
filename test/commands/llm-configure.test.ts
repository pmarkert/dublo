import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWorkspaceDefaultProfile } from "../../src/commands/llm/configure.js";
import { validateLlmCommand } from "../../src/commands/llm/validate.js";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("detects when the configured LLM profile is already the workspace default", () => {
  assert.equal(isWorkspaceDefaultProfile("default", "default"), true);
  assert.equal(isWorkspaceDefaultProfile("default", "haiku"), false);
  assert.equal(isWorkspaceDefaultProfile("", "default"), false);
});

void test("LLM help exposes an editable profile command", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "llm", "edit", "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /llm edit \[options\] \[profile\]/);
  assert.match(result.stdout, /--name <profile>/);
});

void test("LLM validation preflights a locally valid profile by default", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-llm-validate-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  await mkdir(path.join(workspace, "llm"));
  await writeFile(
    path.join(workspace, "llm", "test.json"),
    `${JSON.stringify({ provider: "bedrock", region: "us-east-1", modelId: "test-model" })}\n`
  );

  let preflightCalls = 0;
  await validateLlmCommand("test", {
    workspace,
    createBedrockPlanner() {
      return {
        preflight() {
          preflightCalls += 1;
          return Promise.resolve();
        }
      };
    }
  });

  assert.equal(preflightCalls, 1);
});

void test("LLM validation can skip provider preflight", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-llm-validate-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));
  await mkdir(path.join(workspace, "llm"));
  await writeFile(
    path.join(workspace, "llm", "test.json"),
    `${JSON.stringify({ provider: "bedrock", region: "us-east-1", modelId: "test-model" })}\n`
  );

  await validateLlmCommand("test", {
    workspace,
    preflight: false,
    createBedrockPlanner() {
      throw new Error("Preflight should be skipped.");
    }
  });
});
