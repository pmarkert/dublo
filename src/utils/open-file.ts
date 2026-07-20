import { spawn } from "node:child_process";
import process from "node:process";

export interface ViewerCommand {
  args: string[];
  command: string;
}

export function defaultViewerCommand(
  targetPath: string,
  platform = process.platform
): ViewerCommand {
  if (platform === "darwin") {
    return { command: "open", args: [targetPath] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", targetPath] };
  }
  return { command: "xdg-open", args: [targetPath] };
}

export async function openInDefaultViewer(targetPath: string): Promise<void> {
  const { command, args } = defaultViewerCommand(targetPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      if (process.platform !== "win32") child.unref();
      resolve();
    });
  });
}
