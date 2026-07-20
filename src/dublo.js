#!/usr/bin/env node
import tab from "@bomb.sh/tab/commander";
import { Command } from "commander";
import { addRunOptionValueCompletions } from "./utils/command-registration-helpers.js";
import { registerConfigureCommand } from "./commands/register-configure-command.js";
import { registerRunCommand } from "./commands/register-run-command.js";
import registerLlmCommands from "./commands/llm/index.js";
import registerPersonaCommands from "./commands/persona/index.js";
import registerScenarioCommands from "./commands/scenario/index.js";
import registerContextCommands from "./commands/context/index.js";
import registerReportCommands from "./commands/report/index.js";
import registerRunsCommands from "./commands/runs/index.js";

const program = new Command();

program
  .name("dublo")
  .description("Agentic LLM loop web testing with Playwright + AWS Bedrock")
  .version("0.1.0", "--version");

registerConfigureCommand(program);
registerRunCommand(program);
registerLlmCommands(program);
registerPersonaCommands(program);
registerScenarioCommands(program);
registerContextCommands(program);
registerRunsCommands(program);
registerReportCommands(program);

const completion = tab(program, { completionCommandName: "completion" });
completion.commands.delete("completion");
addRunOptionValueCompletions(completion);

program.parseAsync(process.argv).catch((error) => {
  if (isInterruptError(error)) {
    process.stderr.write("Interrupted.\n");
    process.exitCode = 130;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

function isInterruptError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = typeof error.code === "string" ? error.code : "";
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";

  return code === "ABORT_ERR" || name === "AbortError" || /aborted with ctrl\+c/i.test(message);
}
