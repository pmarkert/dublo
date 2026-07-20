import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { InteractionProvider } from "../ports/interaction.js";

export interface CreateTerminalInteractionProviderOptions {
  input?: Readable;
  output?: Writable;
}

export function createTerminalInteractionProvider(
  options: CreateTerminalInteractionProviderOptions = {}
): InteractionProvider {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  return {
    async requestInput(prompt, signal): Promise<string> {
      const terminal = createInterface({ input, output });
      try {
        const answer = signal
          ? await terminal.question(prompt, { signal })
          : await terminal.question(prompt);
        return answer.trim();
      } finally {
        terminal.close();
      }
    }
  };
}
