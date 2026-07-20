import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { runEditor } from "../../utils/editor.js";
import { resolveBlockPath, resolveWorkspacePath } from "./shared.js";

export async function editBlockCommand(name, options = {}) {
  const workspacePath = resolveWorkspacePath(options.workspace);
  const blockPath = resolveBlockPath(workspacePath, name);
  if (!blockPath || !existsSync(blockPath)) {
    throw new Error(`Could not resolve block '${name}' in ${workspacePath}. Import it before editing.`);
  }

  if (!process.stdin.isTTY) {
    let body = "";
    for await (const chunk of process.stdin) {
      body += String(chunk);
    }
    await writeFile(blockPath, body, "utf8");
    process.stdout.write(`Wrote ${blockPath}\n`);
    return;
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = runEditor(editor, blockPath);
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}