#!/usr/bin/env node

import process from "node:process";
import tab from "@bomb.sh/tab/commander";
import { Command } from "commander";
import { registerConfigCommands } from "./cli/config-commands.js";
import { addRunOptionValueCompletions } from "./utils/command-registration-helpers.js";
import registerRunCommand from "./commands/run/index.js";
import registerLlmCommands from "./commands/llm/index.js";
import registerPersonaCommands from "./commands/persona/index.js";
import registerScenarioCommands from "./commands/scenario/index.js";
import registerContextCommands from "./commands/context/index.js";
import registerBlockCommands from "./commands/block/index.js";
import { registerReportCommands } from "./cli/report-commands.js";
import registerSuiteCommands from "./commands/suite/index.js";

const program = new Command();
program.name("dublo").description("Agentic LLM web testing with Playwright").version("0.1.0", "--version");

registerConfigCommands(program);
registerRunCommand(program);
registerLlmCommands(program);
registerPersonaCommands(program);
registerScenarioCommands(program);
registerContextCommands(program);
registerBlockCommands(program);
registerReportCommands(program);
registerSuiteCommands(program);

const completion = tab(program, { completionCommandName: "completion" });
completion.commands.delete("completion");
addRunOptionValueCompletions(completion);

program.parseAsync(process.argv).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error: ${message}\n`);
	process.exitCode = 1;
});