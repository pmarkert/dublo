import { editScenarioCommand } from "./edit.js";
import { listScenarioCommand } from "./list.js";
import { showScenarioCommand } from "./show.js";
import {
  configureTestConfigCommand,
  editTestConfigCommand,
  showTestConfigCommand,
  validateTestConfigCommand
} from "./config.js";

export default function registerScenarioCommands(program, commandName = "scenario") {
  const scenarioProgram = program
    .command(commandName)
    .description("Manage test profiles and run tests");

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

  const configProgram = scenarioProgram
    .command("config [profile]")
    .description("Manage per-test config.json overrides");

  configProgram.addHelpText(
    "after",
    "\nRun 'dublo test config <profile>' without a subcommand to configure that test interactively.\n"
  );
  configProgram.action(async (profile, options) => {
    if (!profile) {
      throw new Error("Test profile name is required. Pass a profile name.");
    }
    await configureTestConfigCommand({ ...options, profile });
  });

  configProgram
    .command("show <profile>")
    .description("Write a test config.json to stdout")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await showTestConfigCommand({ ...options, profile });
    });

  configProgram
    .command("edit <profile>")
    .description("Edit a test config.json")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await editTestConfigCommand({ ...options, profile });
    });

  configProgram
    .command("validate <profile>")
    .description("Validate a test config.json")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await validateTestConfigCommand({ ...options, profile });
    });

  return scenarioProgram;
}
