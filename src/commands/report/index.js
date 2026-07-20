import { renderReportCommand } from "./render.js";

export default function registerReportCommands(program) {
  program
    .command("report <runOrReport>")
    .description("Render report artifacts from a run ID or report.json file")
    .option("--workspace <path>", "Workspace directory (default: DUBLO_WORKSPACE or ./.dublo)")
    .option("--html", "Render summary.html")
    .option("--markdown", "Render summary.md")
    .option("--open", "Open generated report(s) in the OS default viewer")
    .action(async (runOrReport, options) => {
      await renderReportCommand(runOrReport, options);
    });
}
