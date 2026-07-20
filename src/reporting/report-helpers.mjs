import { readFile } from "node:fs/promises";
import path from "node:path";

export function normalizeScreenshotMode(rawValue) {
  const normalized = String(rawValue || "")
    .toLowerCase()
    .trim();
  if (normalized === "fullpage" || normalized === "full-page") return "fullpage";
  if (normalized === "viewport") return "viewport";
  return "none";
}

export function stripAnsi(value) {
  return String(value || "").replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "");
}

export function getSummaryStepUrlParts(stepUrl, baseUrl) {
  if (!stepUrl) {
    return { href: "", label: "n/a" };
  }

  try {
    const resolvedStepUrl = new URL(stepUrl);
    const resolvedBaseUrl = new URL(baseUrl);
    const sameOrigin = resolvedStepUrl.origin === resolvedBaseUrl.origin;
    const basePath = resolvedBaseUrl.pathname.replace(/\/+$/, "") || "/";
    const stepPath = resolvedStepUrl.pathname || "/";

    if (sameOrigin && (basePath === "/" || stepPath === basePath || stepPath.startsWith(`${basePath}/`))) {
      const relativePath = basePath === "/" ? stepPath : stepPath.slice(basePath.length) || "/";
      const search = resolvedStepUrl.search || "";
      const hash = resolvedStepUrl.hash || "";
      return {
        href: stepUrl,
        label: `${relativePath || "/"}${search}${hash}`,
      };
    }
  } catch {
    // Fall back to the full URL text below when parsing fails.
  }

  return { href: stepUrl, label: stepUrl };
}

export function formatSummaryStepUrl(stepUrl, baseUrl) {
  const { href, label } = getSummaryStepUrlParts(stepUrl, baseUrl);
  if (!href) {
    return label;
  }
  return `[${label}](${href})`;
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderJsonHtml(value) {
  if (value === undefined) {
    return "";
  }

  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

export function deriveReportRenderContext(reportPath, report) {
  const runDir = path.dirname(reportPath);
  const runId = String(report.runId || path.basename(runDir));
  const scenario = String(report.objective || "");
  const screenshots = normalizeScreenshotMode(report?.config?.screenshots);
  const llmProvider = String(report?.config?.llm?.provider || "unknown");
  const modelId = String(report?.config?.llm?.modelId || "unknown");
  const modelSummary = `${llmProvider}:${modelId}`;
  const config = report?.config && typeof report.config === "object" ? report.config : { baseUrl: "" };
  return { runDir, runId, scenario, screenshots, modelSummary, config };
}

export async function loadReportFile(reportPathInput) {
  const reportPath = path.resolve(process.cwd(), reportPathInput);
  const reportContent = await readFile(reportPath, "utf8");

  let report;
  try {
    report = JSON.parse(reportContent);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid report JSON in '${reportPath}': ${detail}`);
  }

  if (!report || typeof report !== "object") {
    throw new Error(`Report '${reportPath}' must contain an object.`);
  }

  return {
    reportPath,
    report,
    context: deriveReportRenderContext(reportPath, report),
  };
}

export function normalizeReportGenerators(value, fallback = ["markdown", "html"]) {
  const fallbackList = Array.isArray(fallback) ? fallback : [fallback];

  if (value === undefined || value === null) {
    return fallbackList;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallbackList;
    }
    if (trimmed.toLowerCase() === "none") {
      return [];
    }

    return trimmed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }

  return fallbackList;
}