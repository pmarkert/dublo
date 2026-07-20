import { listRunsCommand } from "./list.js";

export default function registerRunsCommands(program) {
  const runsProgram = program
    .command("runs")
    .description("List and inspect saved runs");

  runsProgram
    .command("list")
    .description("List available runs from the workspace output directory")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listRunsCommand(options);
    });
}
