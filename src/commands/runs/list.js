import { listAvailableRuns } from "../../utils/run-reports.js";

export async function listRunsCommand(options = {}) {
  const runs = listAvailableRuns(options);
  if (runs.length === 0) {
    process.stdout.write("No runs found.\n");
    return;
  }

  for (const run of runs) {
    const suffix = run.objective ? ` :: ${run.objective}` : "";
    process.stdout.write(`${run.runId}\t${run.status}${suffix}\n`);
  }
}