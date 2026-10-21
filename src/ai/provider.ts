import type { CancellationToken } from 'vscode';
import { extractJson, JsonExtractError, looksCutOff } from './json';
import type { Lookups } from './lookups';
import type { ModelInfo, Slot } from './modelPick';

export interface AIRequest {
  slot: Slot;
  /** Instructions for the model. Sent ahead of the user content. */
  system: string;
  user: string;
  /** Shown by VS Code when it asks the user to allow codelearn to use a model. */
  justification: string;
  /** What the request is for, shown in the usage tally, e.g. "lesson: LINQ". */
  purpose: string;
  /** Lets the model look things up in the repo (read-only, capped) before it answers. */
  lookups?: Lookups;
}

export interface TokenUsage {
  input: number;
  output: number;
  /** false when the provider doesn't report tokens and they were estimated. */
  exact: boolean;
  /** What the request would cost at API list prices, when the provider reports it. */
  costUSD?: number;
}

export interface AIResult {
  text: string;
  model: string;
  usage?: TokenUsage;
  /** Lookups the model made. */
  lookups?: number;
}

/**
 * Anything that can answer a prompt: GitHub Copilot via VS Code's Language Model API,
 * or the Claude Code command line. Other providers (an API key, a local model) can
 * implement this too.
 */
export interface AIProvider {
  /** Shown to the learner, e.g. in the scan estimate. */
  name(): Promise<string>;
  listModels(): Promise<ModelInfo[]>;
  /** The model that would serve this slot right now, if any. */
  modelFor(slot: Slot): Promise<ModelInfo | undefined>;
  complete(req: AIRequest, token?: CancellationToken): Promise<AIResult>;
}

export class AIUnavailableError extends Error {}

/** The model answered with no text at all. Asking again for JSON won't help, so it isn't retried. */
export class AIEmptyReplyError extends AIUnavailableError {}

/** The model's replies kept stopping before the JSON was complete, so its output limit is too small. */
export class AIReplyCutOffError extends AIUnavailableError {}

/**
 * Asks for JSON, and if the reply doesn't parse, asks once more: for a shorter reply when the
 * first was cut off, else with the parse error. An empty reply isn't asked again.
 * `normalize` turns the parsed value into a trusted shape (dropping anything malformed).
 */
export async function completeJson<T>(
  provider: AIProvider,
  req: AIRequest,
  normalize: (value: unknown) => T,
  token?: CancellationToken,
): Promise<{ value: T; model: string }> {
  const parse = (r: AIResult): T => {
    if (!r.text.trim()) {
      throw new AIEmptyReplyError(`${r.model} sent back an empty reply. Try again, or pick another model for the ${req.slot} slot with "codelearn: Choose AI models".`);
    }
    return normalize(extractJson(r.text));
  };

  const first = await provider.complete(req, token);
  try {
    return { value: parse(first), model: first.model };
  } catch (e) {
    if (!(e instanceof JsonExtractError)) throw e;
    const cut = looksCutOff(first.text);
    const ask = cut
      ? `Your previous reply was cut off after ${first.text.length} characters, before the JSON was complete. ` +
        `Reply again with the complete JSON object in well under ${Math.round(first.text.length * 0.6)} characters: fewer items and shorter text. No prose and no code fences.`
      : `Your previous reply could not be parsed: ${e.message}\nReply again with ONLY the JSON object, no prose and no code fences.`;
    // No lookups the second time: the model already had its chance to look, and it costs requests.
    const retry = await provider.complete({ ...req, lookups: undefined, user: `${req.user}\n\n${ask}` }, token);
    try {
      return { value: parse(retry), model: retry.model };
    } catch (e2) {
      if (!(e2 instanceof JsonExtractError)) throw e2;
      if (looksCutOff(retry.text)) {
        throw new AIReplyCutOffError(
          `${retry.model}'s reply was cut off before the JSON was complete${cut ? ', twice' : ''} (${first.text.length} then ${retry.text.length} characters). ` +
            `Its output limit is probably too small for this request: pick another model for the ${req.slot} slot with "codelearn: Choose AI models".`,
        );
      }
      throw new JsonExtractError(`${retry.model}'s reply was not valid JSON, twice (${first.text.length} then ${retry.text.length} characters; ${e2.message.replace(/^The AI reply was not valid JSON /, '')}).`);
    }
  }
}
