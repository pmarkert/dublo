import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBlockCommand } from "../../src/commands/block/import.js";
import { BlockActionSchema } from "../../src/commands/block/shared.js";
import { PlannerActionSchema } from "../../src/ports/planner.js";

void test("imports successful replayable steps after startup from the latest run", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-block-import-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const runId = "run-1";
  const outputDir = path.join(workspace, "reports");
  const reportPath = path.join(outputDir, runId, "report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    path.join(workspace, "defaults.json"),
    `${JSON.stringify({ outputDir: "./reports" })}\n`
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({
      runId,
      status: "passed",
      steps: [
        { index: 1, outcome: "ok", plannerAction: { action: "finish", reason: "Startup." } },
        {
          index: 2,
          outcome: "ok",
          plannerAction: {
            action: "fill",
            reason: "Email.",
            targetId: "a2",
            value: "{{context:login.email}}"
          }
        },
        {
          index: 3,
          outcome: "ok",
          plannerAction: {
            action: "wait_until_gone",
            reason: "Loading.",
            expectGone: { documentText: "Loading" }
          }
        },
        { index: 4, outcome: "ok", plannerAction: { action: "finish", reason: "Done." } },
        {
          index: 5,
          outcome: "error",
          plannerAction: { action: "click", reason: "Ignore.", targetId: "a3" }
        }
      ]
    })}\n`
  );
  await writeFile(
    path.join(outputDir, "latest.json"),
    `${JSON.stringify({ runId, reportPath })}\n`
  );

  await importBlockCommand("login", undefined, { workspace });

  const block: unknown = JSON.parse(
    await readFile(path.join(workspace, "blocks", "login.json"), "utf8")
  );
  assert.deepEqual(block, {
    version: 1,
    name: "login",
    source: { runId, steps: [2, 3] },
    actions: [
      { action: "fill", reason: "Email.", targetId: "a2", value: "{{context:login.email}}" },
      {
        action: "wait_until_gone",
        reason: "Loading.",
        expectGone: { documentText: "Loading" }
      }
    ]
  });
});

void test("allows a block wait to name alternative transient document texts", () => {
  assert.deepEqual(
    BlockActionSchema.parse({
      action: "wait_until_gone",
      reason: "Wait for the login splash screens.",
      expectGone: { documentText: ["Loading your account", "Still loading your details"] }
    }),
    {
      action: "wait_until_gone",
      reason: "Wait for the login splash screens.",
      expectGone: { documentText: ["Loading your account", "Still loading your details"] }
    }
  );
});

void test("requires planner waits to name one observed document text", () => {
  assert.throws(() =>
    PlannerActionSchema.parse({
      action: "wait_until_gone",
      reason: "Loading.",
      expectGone: { documentText: ["Loading your account", "Still loading your details"] }
    })
  );
});

void test("rejects importing a failed run", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-block-import-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  const outputDir = path.join(workspace, "reports");
  const reportPath = path.join(outputDir, "failed-run", "report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    path.join(workspace, "defaults.json"),
    `${JSON.stringify({ outputDir: "./reports" })}\n`
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({ runId: "failed-run", status: "failed", steps: [] })}\n`
  );

  await assert.rejects(
    () => importBlockCommand("login", "failed-run", { workspace }),
    /Only passed runs can be imported/
  );
});
