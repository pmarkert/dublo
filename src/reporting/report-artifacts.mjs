import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadReportFile, normalizeReportGenerators } from "./report-helpers.mjs";
import { reportGenerator as markdownReportGenerator } from "./markdown-report.mjs";
import { reportGenerator as htmlReportGenerator } from "./html-report.mjs";

export const DEFAULT_REPORT_GENERATORS = ["markdown", "html"];

const REPORT_GENERATORS = new Map([
  [markdownReportGenerator.id, markdownReportGenerator],
  [htmlReportGenerator.id, htmlReportGenerator],
]);

export function listReportGenerators() {
  return Array.from(REPORT_GENERATORS.values()).map((generator) => ({
    id: generator.id,
    outputFileName: generator.outputFileName,
  }));
}

export async function generateReportArtifacts(reportPathInput, generatorIds = DEFAULT_REPORT_GENERATORS) {
  const { reportPath, report, context } = await loadReportFile(reportPathInput);
  const requestedGeneratorIds = normalizeReportGenerators(generatorIds, DEFAULT_REPORT_GENERATORS);
  const runDir = context.runDir;

  const results = [];
  for (const generatorId of requestedGeneratorIds) {
    const generator = REPORT_GENERATORS.get(generatorId);
    if (!generator) {
      throw new Error(
        `Unknown report generator '${generatorId}'. Available generators: ${Array.from(REPORT_GENERATORS.keys()).join(", ")}.`
      );
    }

    const outputPath = path.join(runDir, generator.outputFileName);
    const content = generator.render({ report, context });
    await writeFile(outputPath, `${content}\n`, "utf8");
    results.push({
      generatorId: generator.id,
      outputPath,
    });
  }

  const byGenerator = Object.fromEntries(results.map((entry) => [entry.generatorId, entry.outputPath]));

  return {
    reportPath,
    generated: results,
    summaryPath: byGenerator.markdown,
    summaryHtmlPath: byGenerator.html,
  };
}

export async function rerenderReportArtifacts(reportPathInput) {
  return generateReportArtifacts(reportPathInput, DEFAULT_REPORT_GENERATORS);
}
