import { configureLlmCommand } from "./configure.js";
import { editLlmCommand } from "./edit.js";
import { listLlmCommand } from "./list.js";
import { showLlmCommand } from "./show.js";
import { validateLlmCommand } from "./validate.js";

export default function registerLlmCommands(program) {
  const llmProgram = program
    .command("llm")
    .description("Manage LLM profiles");

  llmProgram
    .command("config [profile]")
    .description("Interactively create or update an LLM profile")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--region <region>", "Bedrock region override")
    .option("--model-id <id>", "Bedrock model ID override")
    .option("--inference-profile <scope>", "Inference profile scope for models that support it (global or us)")
    .option("--service-tier <tier>", "Service tier for models that support it (default, priority, flex, reserved)")
    .option("--set-default", "Set workspace config llm field to this profile (non-interactive mode)")
    .option("-y, --yes", "Accept defaults/flags and write profile without prompts")
    .action(async (profile, options) => {
      await configureLlmCommand({
        ...options,
        profile,
      });
    });

  llmProgram
    .command("list")
    .description("List available LLM profiles")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .action(async (options) => {
      await listLlmCommand(options);
    });

  llmProgram
    .command("show [profile]")
    .description("Show the resolved LLM profile JSON")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--name <profile>", "LLM profile name override")
    .action(async (profile, options) => {
      await showLlmCommand(profile, options);
    });

  llmProgram
    .command("edit [profile]")
    .description("Write profile JSON from stdin or open an interactive editor")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--name <profile>", "LLM profile name override")
    .action(async (profile, options) => {
      await editLlmCommand(profile, options);
    });

  llmProgram
    .command("validate [profile]")
    .description("Validate one or all LLM profiles and test provider connectivity")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--name <profile>", "LLM profile name override")
    .option("--no-preflight", "Skip the provider request and validate profile files only")
    .action(async (profile, options) => {
      await validateLlmCommand(profile, options);
    });
}
