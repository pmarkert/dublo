import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runEditor } from "../../utils/editor.js";
import {
  defaultContextProfilePath,
  preferredContextExtension,
  resolveWorkspaceContextProfilePath,
  resolveWorkspacePath,
  sanitizeContextProfileName
} from "./shared.js";

export async function editContextCommand(options = {}) {
  const rawName = String(options.profile || options.name || "").trim();
  if (!rawName) {
    throw new Error("Context profile name is required. Pass a profile name.");
  }

  const forceYaml = Boolean(options.yaml);
  const forceJson = Boolean(options.json);
  if (forceYaml && forceJson) {
    throw new Error("Choose only one context output format flag: --yaml or --json.");
  }

  const workspacePath = resolveWorkspacePath(options.workspace);
  const contextDir = path.join(workspacePath, "context");
  await mkdir(contextDir, { recursive: true });

  const profileName = sanitizeContextProfileName(rawName);
  const existingProfilePath = resolveWorkspaceContextProfilePath(workspacePath, rawName);

  let profilePath;
  if (forceYaml || forceJson) {
    const desiredExt = forceJson ? ".json" : preferredYamlExtension(rawName);
    const oppositePaths = forceJson
      ? [
        defaultContextProfilePath(workspacePath, profileName, ".yaml"),
        defaultContextProfilePath(workspacePath, profileName, ".yml")
      ]
      : [defaultContextProfilePath(workspacePath, profileName, ".json")];

    if (existingProfilePath) {
      if (!pathMatchesFormat(existingProfilePath, forceJson ? "json" : "yaml")) {
        throw new Error(
          `Context profile '${profileName}' already exists as '${existingProfilePath}', which does not match the requested format.`
        );
      }
      profilePath = existingProfilePath;
    } else {
      const desiredPath = defaultContextProfilePath(workspacePath, profileName, desiredExt);
      const oppositeExistingPath = oppositePaths.find((candidate) => existsSync(candidate));
      if (!existsSync(desiredPath) && oppositeExistingPath) {
        throw new Error(
          `Cannot create '${desiredPath}' because '${oppositeExistingPath}' already exists. Use matching format flags or edit the existing file.`
        );
      }
      profilePath = desiredPath;
    }
  } else {
    profilePath = existingProfilePath || defaultContextProfilePath(
      workspacePath,
      profileName,
      preferredContextExtension(rawName)
    );
  }

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
    await writeFile(profilePath, initialContextProfileContent(profilePath), "utf8");
  }

  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = runEditor(editor, profilePath);

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}

function preferredYamlExtension(value) {
  return String(value || "").toLowerCase().trim().endsWith(".yml") ? ".yml" : ".yaml";
}

export function initialContextProfileContent(profilePath) {
  const extension = path.extname(profilePath).toLowerCase();
  return extension === ".yaml" || extension === ".yml"
    ? "# YAML or JSON data\n"
    : "{}\n";
}

function pathMatchesFormat(filePath, format) {
  const ext = path.extname(filePath).toLowerCase();
  if (format === "json") {
    return ext === ".json";
  }

  return ext === ".yaml" || ext === ".yml";
}
