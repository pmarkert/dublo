import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as yaml from "js-yaml";
import test from "node:test";
import {
  expandTasks,
  runSuite,
  SuiteManifestSchema,
  type SuiteManifest
} from "../../src/utils/suite-runner.js";
import {
  formatSuiteId,
  initialSuiteManifestContent,
  resolveSuiteArtifactPath
} from "../../src/commands/suite/index.js";
import { createSuiteRunReport, type TaskResult } from "../../src/utils/suite-runner.js";
import {
  renderSuiteReportHtml,
  renderSuiteReportMarkdown
} from "../../src/reporting/suite-report.js";

const cliPath = path.resolve(import.meta.dirname, "../../src/cli.ts");
const suiteDir = "/tmp/test-suite";

void test("new suite template documents task and matrix manifest structures", () => {
  const template = initialSuiteManifestContent();

  assert.match(template, /# Optional suite-wide settings:/);
  assert.match(template, /tasks:\n {2}- scenario: homepage-smoke/);
  assert.match(template, /# Or replace tasks above with a matrix/);
  assert.match(template, /# matrix:\n# {3}scenarios:/);
  assert.equal(SuiteManifestSchema.safeParse(yaml.load(template)).success, true);
});

void test("suite artifact resolution accepts an explicit suite directory", async () => {
  const suiteDirectory = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-artifact-"));
  const summaryPath = path.join(suiteDirectory, "summary.html");
  await writeFile(path.join(suiteDirectory, "suite.json"), "{}\n", "utf8");
  await writeFile(summaryPath, "<html></html>\n", "utf8");

  assert.equal(resolveSuiteArtifactPath(suiteDirectory), summaryPath);
  assert.equal(
    resolveSuiteArtifactPath(suiteDirectory, { json: true }),
    path.join(suiteDirectory, "suite.json")
  );
});

void test("suite run IDs use the regular-run timestamp prefix and manifest name", () => {
  assert.equal(
    formatSuiteId("/tmp/suites/checkout.yaml", new Date("2026-07-21T16:12:02.293Z")),
    "2026-07-21T16-12-02-293Z_suite_checkout"
  );
});

void test("suite reports include the fields required by report commands", () => {
  const task: TaskResult = {
    index: 0,
    label: "checkout",
    scenario: "checkout",
    context: [],
    status: "passed",
    runId: "run-1",
    runDir: "/tmp/reports/run-1",
    reportPath: "/tmp/reports/run-1/report.json",
    summaryHtmlPath: "/tmp/reports/run-1/summary.html",
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
      plannerCalls: 3
    },
    costTotal: { currency: "USD", total: 0.0125 },
    durationMs: 100,
    errorMessage: undefined
  };
  const suiteReport = createSuiteRunReport({
    suiteId: "2026-07-21T16-12-02-293Z_suite_checkout",
    suiteDir: "/tmp/reports/2026-07-21T16-12-02-293Z_suite_checkout",
    manifestPath: "/tmp/suites/checkout.yaml",
    startedAt: "2026-07-21T16:12:02.293Z",
    finishedAt: "2026-07-21T16:12:09.293Z",
    concurrency: 2,
    tasks: [task],
    passed: 1,
    failed: 0,
    errored: 0,
    skipped: 0,
    total: 1,
    tokenUsage: task.tokenUsage,
    costTotals: [task.costTotal]
  });

  assert.equal(suiteReport.runId, "2026-07-21T16-12-02-293Z_suite_checkout");
  assert.equal(suiteReport.status, "passed");
  assert.equal(suiteReport.objective, "Suite 2026-07-21T16-12-02-293Z_suite_checkout");
  assert.deepEqual(suiteReport.steps, [task]);
  assert.equal(suiteReport.tokenUsage?.totalTokens, 15);
  assert.deepEqual(suiteReport.costTotals, [{ currency: "USD", total: 0.0125 }]);
});

void test("suite summaries render aggregated token usage and costs when available", () => {
  const result = {
    suiteId: "2026-07-21T16-12-02-293Z_suite_checkout",
    suiteDir: "/tmp/reports/2026-07-21T16-12-02-293Z_suite_checkout",
    manifestPath: "/tmp/suites/checkout.yaml",
    startedAt: "2026-07-21T16:12:02.293Z",
    finishedAt: "2026-07-21T16:12:09.293Z",
    concurrency: 1,
    tasks: [],
    passed: 1,
    failed: 0,
    errored: 0,
    skipped: 0,
    total: 1,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
      plannerCalls: 3
    },
    costTotals: [{ currency: "USD", total: 0.0125 }]
  };

  assert.match(renderSuiteReportHtml(result), /Tokens:<\/strong> 15 across 3 planner calls/);
  assert.match(renderSuiteReportHtml(result), /Estimated cost:<\/strong> 0\.012500 USD/);
  assert.match(renderSuiteReportMarkdown(result), /\*\*Tokens:\*\* 15 across 3 planner calls/);
  assert.match(renderSuiteReportMarkdown(result), /\*\*Estimated Cost:\*\* 0\.012500 USD/);
});

void test("report show resolves a suite from the standard latest manifest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-report-command-"));
  const outputDir = path.join(workspace, "reports");
  const runId = "2026-07-21T16-12-02-293Z_suite_checkout";
  const runDir = path.join(outputDir, runId);
  const reportPath = path.join(runDir, "report.json");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "defaults.json"), '{"outputDir":"./reports"}\n', "utf8");
  await writeFile(
    reportPath,
    JSON.stringify({
      runId,
      objective: `Suite ${runId}`,
      status: "passed",
      startedAt: "2026-07-21T16:12:02.293Z",
      finishedAt: "2026-07-21T16:12:09.293Z",
      finalUrl: "",
      steps: []
    }) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "latest.json"),
    JSON.stringify({ runId, reportPath }) + "\n",
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "report", "show", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Run ID: ${runId}`));
  assert.match(result.stdout, /Status: passed/);
});

// ---------------------------------------------------------------------------
// expandTasks — matrix expansion
// ---------------------------------------------------------------------------

void test("expandTasks produces cartesian product for matrix with contexts", () => {
  const manifest: SuiteManifest = {
    matrix: {
      scenarios: ["checkout", "login"],
      contexts: [["qa-user"], ["prod-user"]]
    }
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks.length, 4);

  assert.equal(tasks[0]?.scenario, "checkout");
  assert.deepEqual(tasks[0]?.context, ["qa-user"]);

  assert.equal(tasks[1]?.scenario, "checkout");
  assert.deepEqual(tasks[1]?.context, ["prod-user"]);

  assert.equal(tasks[2]?.scenario, "login");
  assert.deepEqual(tasks[2]?.context, ["qa-user"]);

  assert.equal(tasks[3]?.scenario, "login");
  assert.deepEqual(tasks[3]?.context, ["prod-user"]);
});

void test("suite validate reports invalid workspace manifests", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-validation-"));
  const suitesDirectory = path.join(workspace, "suites");
  await mkdir(suitesDirectory, { recursive: true });
  await writeFile(path.join(suitesDirectory, "broken.yaml"), "tasks: []\n", "utf8");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "suite", "validate", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL broken/);
  assert.match(result.stderr, /One or more suites are invalid/);
});

void test("suite validate reports missing scenario and context references", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-references-"));
  const suitesDirectory = path.join(workspace, "suites");
  await mkdir(suitesDirectory, { recursive: true });
  await writeFile(
    path.join(suitesDirectory, "missing-references.yaml"),
    "tasks:\n  - scenario: missing-scenario\n    context: missing-context\n",
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "suite", "validate", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /scenario 'missing-scenario' could not be resolved/);
  assert.match(result.stdout, /context 'missing-context' could not be resolved/);
});

void test("expandTasks produces one task per scenario when matrix has no contexts", () => {
  const manifest: SuiteManifest = {
    matrix: { scenarios: ["homepage", "checkout"] }
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0]?.context, []);
  assert.deepEqual(tasks[1]?.context, []);
});

void test("expandTasks supports string context shorthand in matrix", () => {
  const manifest: SuiteManifest = {
    matrix: {
      scenarios: ["smoke"],
      contexts: ["qa-user", "prod-user"]
    }
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0]?.context, ["qa-user"]);
  assert.deepEqual(tasks[1]?.context, ["prod-user"]);
});

// ---------------------------------------------------------------------------
// expandTasks — explicit tasks
// ---------------------------------------------------------------------------

void test("expandTasks uses explicit tasks list", () => {
  const manifest: SuiteManifest = {
    tasks: [{ scenario: "checkout", context: ["qa-user", "tenant-a"] }, { scenario: "login" }]
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0]?.context, ["qa-user", "tenant-a"]);
  assert.equal(tasks[0]?.scenario, "checkout");
  assert.deepEqual(tasks[1]?.context, []);
  assert.equal(tasks[1]?.scenario, "login");
});

void test("expandTasks applies custom label from task", () => {
  const manifest: SuiteManifest = {
    tasks: [{ scenario: "checkout", context: "qa-user", label: "my-custom-label" }]
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks[0]?.label, "my-custom-label");
});

void test("expandTasks normalizes task dependency shorthand and status conditions", () => {
  const tasks = expandTasks(
    {
      tasks: [
        { scenario: "setup", id: "init", label: "setup" },
        {
          scenario: "verify",
          dependsOn: { task: "init", status: ["success", "fail"] }
        },
        { scenario: "cleanup", label: "cleanup", dependsOn: ["setup", { task: "init" }] }
      ]
    },
    suiteDir
  );

  assert.deepEqual(tasks[1]?.dependsOn, [
    { task: "init", statuses: ["passed", "failed"] }
  ]);
  assert.deepEqual(tasks[2]?.dependsOn, [
    { task: "setup", statuses: ["passed"] },
    { task: "init", statuses: ["passed"] }
  ]);
});

void test("expandTasks rejects invalid task dependency labels and cycles", () => {
  assert.throws(
    () => expandTasks({ tasks: [{ scenario: "verify", dependsOn: ["missing"] }] }, suiteDir),
    /depends on unknown task 'missing'/
  );
  assert.throws(
    () =>
      expandTasks(
        {
          tasks: [
            { scenario: "first", dependsOn: ["second"] },
            { scenario: "second", dependsOn: ["first"] }
          ]
        },
        suiteDir
      ),
    /dependency cycle/
  );
});

void test("runSuite requires every matching dependency task to meet an allowed status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-dependencies-"));
  const runnerPath = path.join(root, "dependency-runner.mjs");
  await writeFile(
    runnerPath,
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'const outputDir = process.argv[process.argv.indexOf("--output-dir") + 1];',
      'const scenario = process.argv[process.argv.indexOf("run") + 1];',
      "await mkdir(outputDir, { recursive: true });",
      'const status = scenario === "passed-init" ? "passed" : "failed";',
      'await writeFile(path.join(outputDir, "latest.json"), JSON.stringify({ status }));'
    ].join("\n"),
    "utf8"
  );

  const originalCliPath = process.argv[1];
  process.argv[1] = runnerPath;
  try {
    const result = await runSuite(
      {
        concurrency: 3,
        tasks: [
          { scenario: "passed-init", label: "init" },
          { scenario: "failed-init", label: "init" },
          {
            scenario: "runs-after-either-init-status",
            dependsOn: { task: "init", status: ["success", "fail"] }
          },
          { scenario: "skipped", dependsOn: "init" }
        ]
      },
      path.join(root, "suite.yaml"),
      path.join(root, "output"),
      { workspace: root, headless: true }
    );

    assert.deepEqual(
      result.tasks.map((task) => task.status),
      ["passed", "failed", "failed", "skipped"]
    );
    assert.equal(result.skipped, 1);
    assert.match(result.tasks[3]?.errorMessage ?? "", /init expected passed but init was failed/);
  } finally {
    process.argv[1] = originalCliPath;
  }
});

void test("expandTasks inherits suite-level llm and persona", () => {
  const manifest: SuiteManifest = {
    llm: "nova-pro",
    persona: "qa-strict",
    tasks: [{ scenario: "smoke" }]
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks[0]?.llm, "nova-pro");
  assert.equal(tasks[0]?.persona, "qa-strict");
});

void test("expandTasks task-level llm overrides suite-level", () => {
  const manifest: SuiteManifest = {
    llm: "nova-pro",
    tasks: [{ scenario: "smoke", llm: "claude-sonnet" }]
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks[0]?.llm, "claude-sonnet");
});

// ---------------------------------------------------------------------------
// expandTasks — combined matrix + tasks
// ---------------------------------------------------------------------------

void test("expandTasks combines matrix and explicit tasks", () => {
  const manifest: SuiteManifest = {
    matrix: { scenarios: ["smoke"], contexts: [["qa-user"]] },
    tasks: [{ scenario: "admin-smoke", context: "admin-user" }]
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.scenario, "smoke");
  assert.equal(tasks[1]?.scenario, "admin-smoke");
});

// ---------------------------------------------------------------------------
// expandTasks — task directory naming
// ---------------------------------------------------------------------------

void test("expandTasks generates sequential padded directory names", () => {
  const manifest: SuiteManifest = {
    matrix: {
      scenarios: ["a", "b", "c"],
      contexts: [["x"]]
    }
  };

  const tasks = expandTasks(manifest, suiteDir);
  assert.match(tasks[0]?.taskDir ?? "", /\/001_/);
  assert.match(tasks[1]?.taskDir ?? "", /\/002_/);
  assert.match(tasks[2]?.taskDir ?? "", /\/003_/);
});

void test("expandTasks task directories are inside suiteDir/tasks", () => {
  const manifest: SuiteManifest = { tasks: [{ scenario: "smoke" }] };
  const tasks = expandTasks(manifest, "/my/suite");
  assert.match(tasks[0]?.taskDir ?? "", /^\/my\/suite\/tasks\//);
});

// ---------------------------------------------------------------------------
// SuiteManifestSchema validation
// ---------------------------------------------------------------------------

void test("SuiteManifestSchema rejects manifest with neither tasks nor matrix", () => {
  const result = SuiteManifestSchema.safeParse({ workspace: "./.dublo" });
  assert.equal(result.success, false);
});

void test("SuiteManifestSchema accepts manifest with only matrix", () => {
  const result = SuiteManifestSchema.safeParse({
    matrix: { scenarios: ["smoke"] }
  });
  assert.equal(result.success, true);
});

void test("SuiteManifestSchema accepts manifest with only tasks", () => {
  const result = SuiteManifestSchema.safeParse({
    tasks: [{ scenario: "smoke" }]
  });
  assert.equal(result.success, true);
});

void test("SuiteManifestSchema rejects empty tasks array", () => {
  const result = SuiteManifestSchema.safeParse({ tasks: [] });
  assert.equal(result.success, false);
});

void test("SuiteManifestSchema rejects concurrency above 20", () => {
  const result = SuiteManifestSchema.safeParse({
    concurrency: 99,
    tasks: [{ scenario: "smoke" }]
  });
  assert.equal(result.success, false);
});

void test("SuiteManifestSchema rejects unknown top-level keys", () => {
  const result = SuiteManifestSchema.safeParse({
    tasks: [{ scenario: "smoke" }],
    unknownField: true
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// CLI integration — suite --help
// ---------------------------------------------------------------------------

void test("suite command is registered and shows help", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "suite", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /suite/);
});

void test("suite run --help shows expected options", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "suite", "run", "--help"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--concurrency/);
  assert.match(result.stdout, /--headless/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--output-dir/);
});

void test("suite open --help shows expected options", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "suite", "open", "--help"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--markdown/);
  assert.match(result.stdout, /--json/);
});

void test("suite list, show, edit, and validate manage workspace manifests", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dublo-suite-commands-"));
  const suitesDirectory = path.join(workspace, "suites");
  const scenariosDirectory = path.join(workspace, "scenarios");
  await Promise.all([
    mkdir(suitesDirectory, { recursive: true }),
    mkdir(scenariosDirectory, { recursive: true })
  ]);
  await writeFile(
    path.join(scenariosDirectory, "homepage-smoke.md"),
    "Verify the home page loads.",
    "utf8"
  );
  await writeFile(
    path.join(suitesDirectory, "smoke.yaml"),
    "tasks:\n  - scenario: homepage-smoke\n",
    "utf8"
  );

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

  const list = runCli("suite", "list", "--workspace", workspace);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /smoke/);

  const show = runCli("suite", "show", "smoke", "--workspace", workspace);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /scenario: homepage-smoke/);

  const validate = runCli("suite", "validate", "--workspace", workspace);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /OK\s+smoke/);

  const edit = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "suite", "edit", "checkout", "--workspace", workspace],
    { cwd: process.cwd(), encoding: "utf8", input: "tasks:\n  - scenario: checkout-happy-path\n" }
  );
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(
    await readFile(path.join(suitesDirectory, "checkout.yaml"), "utf8"),
    /checkout-happy-path/
  );
});

// ---------------------------------------------------------------------------
// CLI integration — run --output-dir option
// ---------------------------------------------------------------------------

void test("run command exposes --output-dir option", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "run", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--output-dir/);
});
