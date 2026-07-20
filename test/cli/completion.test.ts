import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");

void test("tab completion suggests workspace profiles, run IDs, and enum values", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-completion-"));
  t.after(async () => rm(workspace, { force: true, recursive: true }));

  await Promise.all([
    mkdir(path.join(workspace, ".dublo", "llm"), { recursive: true }),
    mkdir(path.join(workspace, "runs", "20260720_120000_pass_checkout"), { recursive: true })
  ]);
  await writeFile(
    path.join(workspace, ".dublo", "defaults.json"),
    `${JSON.stringify({ outputDir: path.join(workspace, "runs") })}\n`
  );
  await writeFile(path.join(workspace, ".dublo", "llm", "fast.json"), "{}\n");
  await writeFile(
    path.join(workspace, "runs", "20260720_120000_pass_checkout", "report.json"),
    '{"status":"passed"}\n'
  );

  const workspacePath = path.join(workspace, ".dublo");
  assert.match(complete(["run", "--workspace", workspacePath, "--llm="]), /fast\tllm profile/);
  assert.match(
    complete(["report", "show", "--workspace", workspacePath, ""]),
    /20260720_120000_pass_checkout\tpassed run/
  );
  assert.match(complete(["report", "list", "--status="]), /passed\toption/);
  assert.match(complete(["config", "set", ""]), /screenshots\toption/);
});

function complete(args: string[]): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "complete", "--", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
