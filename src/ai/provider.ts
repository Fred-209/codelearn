import type { CancellationToken } from 'vscode';
import { extractJson, JsonExtractError } from './json';
import type { ModelInfo, Slot } from './modelPick';

export interface AIRequest {
  slot: Slot;
  /** Instructions for the model. Sent ahead of the user content. */
  system: string;
  user: string;
  /** Shown by VS Code when it asks the user to allow codelearn to use a model. */
  justification: string;
}

export interface AIResult {
  text: string;
  model: string;
}

/**
 * Anything that can answer a prompt. The default is GitHub Copilot via VS Code's
 * Language Model API; other providers (an API key, a local model) can implement this.
 */
export interface AIProvider {
  listModels(): Promise<ModelInfo[]>;
  /** The model that would serve this slot right now, if any. */
  modelFor(slot: Slot): Promise<ModelInfo | undefined>;
  complete(req: AIRequest, token?: CancellationToken): Promise<AIResult>;
}

export class AIUnavailableError extends Error {}

/**
 * Asks for JSON, and if the reply doesn't parse, asks once more with the parse error.
 * `normalize` turns the parsed value into a trusted shape (dropping anything malformed).
 */
export async function completeJson<T>(
  provider: AIProvider,
  req: AIRequest,
  normalize: (value: unknown) => T,
  token?: CancellationToken,
): Promise<{ value: T; model: string }> {
  const first = await provider.complete(req, token);
  try {
    return { value: normalize(extractJson(first.text)), model: first.model };
  } catch (e) {
    if (!(e instanceof JsonExtractError)) throw e;
    const retry = await provider.complete(
      {
        ...req,
        user: `${req.user}\n\nYour previous reply could not be parsed: ${e.message}\nReply again with ONLY the JSON object, no prose and no code fences.`,
      },
      token,
    );
    return { value: normalize(extractJson(retry.text)), model: retry.model };
  }
}
