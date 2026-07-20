import { configureCommand } from "./configure.js";

export function registerConfigureCommand(program) {
  program
    .command("config")
    .alias("init")
    .description("Interactively create or update workspace defaults.json")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--prompt", "Edit the workspace prompt markdown file")
    .option("--show-prompt", "Write the workspace prompt markdown file to stdout")
    .option("-y, --yes", "Accept defaults and write config without prompts")
    .action(async (options) => {
      await configureCommand(options);
    });
}