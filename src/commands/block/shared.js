import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const BlockWaitUntilGoneExpectationSchema = z
  .object({
    documentText: z.union([
      z.string().trim().min(1),
      z.array(z.string().trim().min(1)).min(1)
    ])
  })
  .strict();

export const BlockActionSchema = z
  .object({
    action: z.enum(["click", "fill", "wait_until_gone"]),
    reason: z.string().trim().min(1),
    targetId: z.string().trim().min(1).optional(),
    value: z.string().optional(),
    expectGone: BlockWaitUntilGoneExpectationSchema.optional()
  })
  .strict()
  .superRefine((action, context) => {
    if ((action.action === "click" || action.action === "fill") && !action.targetId) {
      context.addIssue({ code: "custom", message: "click and fill actions require targetId." });
    }
    if (action.action === "fill" && action.value === undefined) {
      context.addIssue({ code: "custom", message: "fill actions require value." });
    }
    if (action.action === "wait_until_gone" && !action.expectGone) {
      context.addIssue({ code: "custom", message: "wait_until_gone requires expectGone." });
    }
  });

export const BlockSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1),
    source: z
      .object({
        runId: z.string().trim().min(1),
        steps: z.array(z.number().int().positive()).min(1)
      })
      .strict()
      .optional(),
    actions: z.array(BlockActionSchema).min(1)
  })
  .strict();

export function createBlockAction(plannerAction) {
  return BlockActionSchema.parse(plannerAction);
}

export function resolveWorkspacePath(workspace) {
  const workspaceInput = workspace || process.env.DUBLO_WORKSPACE || "./.dublo";
  return path.resolve(process.cwd(), workspaceInput);
}

export function sanitizeBlockName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!normalized) {
    throw new Error("Block name cannot be empty.");
  }
  return normalized;
}

export function defaultBlockPath(workspacePath, name) {
  return path.join(workspacePath, "blocks", `${sanitizeBlockName(name)}.json`);
}

export function listBlockNames(workspacePath) {
  try {
    return readdirSync(path.join(workspacePath, "blocks"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function resolveBlockPath(workspacePath, value) {
  if (!value) return "";

  const directPath = path.resolve(process.cwd(), value);
  if (isFile(directPath)) return directPath;

  const candidate = defaultBlockPath(workspacePath, value);
  return isFile(candidate) ? candidate : "";
}

export async function readBlock(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read block '${filePath}': ${detail}`);
  }

  try {
    return BlockSchema.parse(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid block '${filePath}': ${detail}`);
  }
}

function isFile(filePath) {
  try {
    return readdirSync(path.dirname(filePath), { withFileTypes: true }).some(
      (entry) => entry.name === path.basename(filePath) && entry.isFile()
    );
  } catch {
    return false;
  }
}