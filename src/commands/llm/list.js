import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { listLlmProfileNames, resolveWorkspacePath } from "./shared.js";

export async function listLlmCommand(options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const names = listLlmProfileNames(workspacePath);
  const workspaceDefault = await readWorkspaceDefault(workspacePath);
  const envDefault = process.env.DUBLO_LLM || "";

  if (names.length === 0) {
    process.stdout.write(`No llm profiles found under ${path.join(workspacePath, "llm")}\n`);
    return;
  }

  process.stdout.write(`LLM profiles in ${path.join(workspacePath, "llm")}:\n`);
  for (const name of names) {
    const markers = [];
    if (workspaceDefault && workspaceDefault === name) markers.push("workspace-default");
    if (envDefault && envDefault === name) markers.push("env-default");
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    process.stdout.write(`- ${name}${suffix}\n`);
  }
}

async function readWorkspaceDefault(workspacePath) {
  const configPath = path.join(workspacePath, "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return typeof parsed.llm === "string" ? parsed.llm : "";
    }
  } catch {
    return "";
  }

  return "";
}
