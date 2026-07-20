import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WorkspaceDefaultsSchema } from "../core/config/schemas.js";
import type { WorkspaceDefaults } from "../core/config/schemas.js";

const WORKSPACE_DIRECTORIES = ["llm", "personas", "scenarios", "context", "blocks"] as const;

export interface WorkspaceStore {
  ensure(workspace: string): Promise<void>;
  readDefaults(workspace: string): Promise<WorkspaceDefaults>;
  writeDefaults(workspace: string, defaults: WorkspaceDefaults): Promise<void>;
  readPrompt(workspace: string): Promise<string | undefined>;
  writePrompt(workspace: string, prompt: string): Promise<void>;
  resolve(workspace?: string): string;
}

export interface CreateWorkspaceStoreOptions {
  cwd?: string;
}

export function createWorkspaceStore(options: CreateWorkspaceStoreOptions = {}): WorkspaceStore {
  const cwd = options.cwd ?? process.cwd();

  return {
    async ensure(workspace) {
      await mkdir(workspace, { recursive: true });
      await Promise.all(
        WORKSPACE_DIRECTORIES.map((directory) =>
          mkdir(path.join(workspace, directory), { recursive: true })
        )
      );
    },

    async readDefaults(workspace) {
      const defaultsPath = path.join(workspace, "defaults.json");
      try {
        const content = await readFile(defaultsPath, "utf8");
        return WorkspaceDefaultsSchema.parse(JSON.parse(content));
      } catch (error) {
        if (isMissingFileError(error)) {
          return {};
        }
        throw error;
      }
    },

    async writeDefaults(workspace, defaults) {
      const validated = WorkspaceDefaultsSchema.parse(defaults);
      await mkdir(workspace, { recursive: true });
      await writeAtomically(
        path.join(workspace, "defaults.json"),
        `${JSON.stringify(validated, null, 2)}\n`
      );
    },

    async readPrompt(workspace) {
      try {
        return await readFile(path.join(workspace, "prompt.md"), "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async writePrompt(workspace, prompt) {
      await mkdir(workspace, { recursive: true });
      await writeAtomically(path.join(workspace, "prompt.md"), prompt);
    },

    resolve(workspace = ".dublo") {
      return path.resolve(cwd, workspace);
    }
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}
