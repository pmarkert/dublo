export interface InteractionProvider {
  requestInput(prompt: string, signal?: AbortSignal): Promise<string>;
}
