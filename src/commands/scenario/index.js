import { editScenarioCommand } from "./edit.js";
import { listScenarioCommand } from "./list.js";
import { showScenarioCommand } from "./show.js";

export default function registerScenarioCommands(program) {
  const scenarioProgram = program
    .command("scenario")
    .description("Manage scenario profiles");

  scenarioProgram
    .command("list")
    .description("List available scenario profiles")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listScenarioCommand(options);
    });

  scenarioProgram
    .command("show <profile>")
    .description("Write scenario text to stdout")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await showScenarioCommand({
        ...options,
        profile,
      });
    });

  scenarioProgram
    .command("edit <profile>")
    .description("Write scenario text from stdin or open an interactive editor")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await editScenarioCommand({
        ...options,
        profile,
      });
    });
}
