import { editContextCommand } from "./edit.js";
import { listContextCommand } from "./list.js";
import { showContextCommand } from "./show.js";
import { validateContextCommand } from "./validate.js";

export default function registerContextCommands(program) {
  const contextProgram = program
    .command("context")
    .description("Manage context profiles");

  contextProgram
    .command("list")
    .description("List available context profiles")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listContextCommand(options);
    });

  contextProgram
    .command("show <profile>")
    .description("Write resolved context object as JSON to stdout")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await showContextCommand({
        ...options,
        profile,
      });
    });

  contextProgram
    .command("edit <profile>")
    .description("Write context from stdin or open an interactive editor")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--yaml", "Force YAML file output (.yaml/.yml) for new or matching existing profile")
    .option("--json", "Force JSON file output (.json) for new or matching existing profile")
    .action(async (profile, options) => {
      await editContextCommand({
        ...options,
        profile,
      });
    });

  contextProgram
    .command("validate [profile]")
    .description("Validate one or all context profiles")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--name <profile>", "Context profile name override")
    .action(async (profile, options) => {
      await validateContextCommand(profile, options);
    });
}
