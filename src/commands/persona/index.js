import { editPersonaCommand } from "./edit.js";
import { listPersonaCommand } from "./list.js";
import { showPersonaCommand } from "./show.js";

export default function registerPersonaCommands(program) {
  const personaProgram = program
    .command("persona")
    .description("Manage persona profiles");

  personaProgram
    .command("list")
    .description("List available persona profiles")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listPersonaCommand(options);
    });

  personaProgram
    .command("show <profile>")
    .description("Write persona text to stdout")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await showPersonaCommand({
        ...options,
        profile,
      });
    });

  personaProgram
    .command("edit <profile>")
    .description("Write persona text from stdin or open an interactive editor")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (profile, options) => {
      await editPersonaCommand({
        ...options,
        profile,
      });
    });
}
