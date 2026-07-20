import { spawn } from "node:child_process";
import { generateReportArtifacts } from "../../reporting/report-artifacts.mjs";
import { resolveReportPath } from "../../utils/run-reports.js";

export async function renderReportCommand(reportRef, options = {}) {
  const generators = [];
  if (options.html) {
    generators.push("html");
  }
  if (options.markdown) {
    generators.push("markdown");
  }

  if (generators.length === 0) {
    throw new Error("Select at least one report type with --html or --markdown.");
  }

  const reportPath = resolveReportPath(reportRef, options);
  const result = await generateReportArtifacts(reportPath, generators);

  for (const entry of result.generated) {
    process.stdout.write(`${entry.outputPath}\n`);
    if (options.open) {
      await openPathInDefaultViewer(entry.outputPath);
    }
  }
}

function openPathInDefaultViewer(targetPath) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args =
      platform === "darwin"
        ? [targetPath]
        : platform === "win32"
          ? ["/c", "start", "", targetPath]
          : [targetPath];

    const child = spawn(command, args, {
      stdio: "ignore",
      detached: platform !== "win32",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to open '${targetPath}': ${error instanceof Error ? error.message : String(error)}`));
    });

    child.on("spawn", () => {
      if (platform !== "win32") {
        child.unref();
      }
      resolve();
    });
    if (platform === "win32") {
      resolve();
    }
  });
}

export async function renderAllReportsCommand(reportRef, options = {}) {
  await renderReportCommand(reportRef, {
    ...options,
    html: true,
    markdown: true,
  });
}