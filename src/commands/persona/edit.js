import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  defaultPersonaProfilePath,
  readPersonaText,
  resolveBuiltinPersonaTemplatePath,
  resolveWorkspacePersonaProfilePath,
  resolveWorkspacePath,
  sanitizePersonaProfileName
} from "./shared.js";

export async function editPersonaCommand(options = {}) {
  const rawName = String(options.profile || options.name || "").trim();
  if (!rawName) {
    throw new Error("Persona profile name is required. Pass a profile name.");
  }

  const workspacePath = resolveWorkspacePath(options.workspace);
  const personaDir = path.join(workspacePath, "personas");
  await mkdir(personaDir, { recursive: true });

  const workspaceProfilePath = defaultPersonaProfilePath(workspacePath, sanitizePersonaProfileName(rawName));
  const existingProfilePath = resolveWorkspacePersonaProfilePath(workspacePath, rawName);
  const builtinTemplatePath = resolveBuiltinPersonaTemplatePath(rawName);
  const profilePath = existingProfilePath || workspaceProfilePath;

  if (!process.stdin.isTTY) {
    let body = "";
    for await (const chunk of process.stdin) {
      body += String(chunk);
    }
    await writeFile(profilePath, body, "utf8");
    process.stdout.write(`Wrote ${profilePath}\n`);
    return;
  }

  if (!existsSync(profilePath)) {
    const initialText = builtinTemplatePath ? await readPersonaText(builtinTemplatePath) : "";
    await writeFile(profilePath, initialText, "utf8");
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = spawnSync(editor, [profilePath], {
    stdio: "inherit",
    shell: true
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}
