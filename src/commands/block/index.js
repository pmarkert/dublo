import { editBlockCommand } from "./edit.js";
import { importBlockCommand } from "./import.js";
import { listBlockCommand } from "./list.js";
import { showBlockCommand } from "./show.js";
import { validateBlockCommand } from "./validate.js";

export default function registerBlockCommands(program) {
  const blockProgram = program.command("block").description("Manage reusable initialization blocks");

  blockProgram
    .command("list")
    .description("List reusable initialization blocks")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listBlockCommand(options);
    });

  blockProgram
    .command("show <name>")
    .description("Print a validated reusable initialization block")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (name, options) => {
      await showBlockCommand(name, options);
    });

  blockProgram
    .command("edit <name>")
    .description("Edit an imported reusable initialization block")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (name, options) => {
      await editBlockCommand(name, options);
    });

  blockProgram
    .command("validate [name]")
    .description("Validate one or all reusable initialization blocks")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (name, options) => {
      await validateBlockCommand(name, options);
    });

  blockProgram
    .command("import <name> [run-id]")
    .description("Import successful replayable steps after startup navigation from a report")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (name, runId, options) => {
      await importBlockCommand(name, runId, options);
    });
}