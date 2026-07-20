import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

export function runEditor(editorCommand: string, filePath: string): SpawnSyncReturns<Buffer> {
  const [executable, ...arguments_] = parseEditorCommand(editorCommand);
  if (!executable) {
    throw new Error("Editor command cannot be empty.");
  }
  return spawnSync(executable, [...arguments_, filePath], { stdio: "inherit" });
}

export function parseEditorCommand(command: string): string[] {
  const values: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (value) {
        values.push(value);
        value = "";
      }
      continue;
    }
    value += character;
  }

  if (escaped) value += "\\";
  if (quote) throw new Error(`Editor command has an unterminated ${quote} quote.`);
  if (value) values.push(value);
  return values;
}
