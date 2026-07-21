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
const BlockTargetSelectorSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    role: z.string().optional(),
    type: z.string().optional(),
    priority: z.boolean().optional(),
    text: z.string().optional(),
    ariaLabel: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    hasValue: z.boolean().optional(),
    checked: z.boolean().optional(),
    disabled: z.boolean().optional()
  })
  .strict()
  .refine((target) => Object.keys(target).length > 0, {
    message: "target must contain at least one control property."
  });

const BlockActionPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), target: BlockTargetSelectorSchema }).strict(),
  z
    .object({ action: z.literal("fill"), target: BlockTargetSelectorSchema, value: z.string() })
    .strict(),
  z
    .object({ action: z.literal("wait_until_gone"), expectGone: BlockWaitUntilGoneExpectationSchema })
    .strict()
]);

export const BlockActionSchema = z
  .object({
    reason: z.string().trim().min(1),
    payload: BlockActionPayloadSchema
  })
  .strict();

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