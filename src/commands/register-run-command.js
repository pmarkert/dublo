import { runCommand } from "./run.js";
import { collectOptionValues, collectOrderedContextOperations } from "../utils/command-registration-helpers.js";

export function registerRunCommand(program) {
  program
    .command("run [scenario]")
    .description("Run using workspace config and selectors")
    .option("--workspace <path>", "Workspace directory (contains defaults.json and llm/personas/scenarios/context)")
    .option("--llm <value>", "LLM config file path or profile name in <workspace>/llm")
    .option("--persona <value>", "Persona file path or profile name in <workspace>/personas")
    .option("--scenario <value>", "Scenario file path or profile name in <workspace>/scenarios (or use positional [scenario])")
    .option("--adhoc <text>", "Inline ad hoc scenario text to run without a scenario file")
    .option("--headless", "Run browser in headless mode")
    .option("--debug", "Enable debug logging for this run")
    .option(
      "--context <value>",
      "Context file path or profile name in <workspace>/context (repeatable)",
      collectOptionValues
    )
    .option("--set <keyValue>", "Inline context assignment key.path=value (or key.path:value); repeatable", collectOptionValues)
    .option("--json <object>", "Inline JSON object merged into context (repeatable)", collectOptionValues)
    .action(async (scenarioArg, options) => {
      const orderedContextOperations = collectOrderedContextOperations(process.argv);
      await runCommand({
        ...options,
        scenario: options.scenario || scenarioArg,
        adhocScenario: options.adhoc,
        contextOperations: orderedContextOperations,
      });
    });
}