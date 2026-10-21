import * as vscode from 'vscode';
import { AIEmptyReplyError, AIProvider, AIRequest, AIResult, AIUnavailableError } from './provider';
import { Effort, effortFor, ModelInfo, pickModel, Slot } from './modelPick';

/**
 * Uses the models VS Code exposes to extensions (GitHub Copilot's, including the
 * Claude models Copilot offers). No API key: requests go wherever Copilot sends them.
 */
export class VsCodeLmProvider implements AIProvider {
  constructor(private readonly log?: vscode.LogOutputChannel) {}

  async name(): Promise<string> {
    return 'GitHub Copilot';
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await vscode.lm.selectChatModels();
    return models.map(toInfo);
  }

  async modelFor(slot: Slot): Promise<ModelInfo | undefined> {
    const models = await this.listModels();
    return pickModel(models, slot, settingFor(slot));
  }

  async complete(req: AIRequest, token?: vscode.CancellationToken): Promise<AIResult> {
    const all = await vscode.lm.selectChatModels();
    const info = pickModel(all.map(toInfo), req.slot, settingFor(req.slot));
    const model = info && all.find((m) => m.id === info.id);
    if (!model) {
      throw new AIUnavailableError(
        'No AI model is available. codelearn uses the models from GitHub Copilot: make sure Copilot Chat is installed and you are signed in.',
      );
    }

    // The Language Model API has no system role; instructions go first in the user turn.
    const messages = [vscode.LanguageModelChatMessage.User(`${req.system}\n\n---\n\n${req.user}`)];
    const cts = token ? undefined : new vscode.CancellationTokenSource();
    const cancel = token ?? cts!.token;
    const effort = copilotEffort(effortFor(req.slot, effortSetting(req.slot)));
    const send = async (level: Effort | undefined): Promise<Reply> => {
      const options: CopilotRequestOptions = { justification: req.justification };
      if (level) options.configuration = { reasoningEffort: level };
      const started = Date.now();
      const response = await model.sendRequest(messages, options, cancel);
      const reply: Reply = { text: '', parts: {}, ms: 0 };
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) reply.text += part.value;
        const kind = partKind(part);
        reply.parts[kind] = (reply.parts[kind] ?? 0) + 1;
      }
      reply.ms = Date.now() - started;
      return reply;
    };
    const sendWithEffort = async (level: Effort): Promise<Reply> => {
      if (this.noEffort.has(model.id)) return send(undefined);
      try {
        return await send(level);
      } catch (e) {
        // A model without effort levels may reject the setting: ask again without it, once.
        if (cancel.isCancellationRequested || isAccessError(e)) throw e;
        this.noEffort.add(model.id);
        return send(undefined);
      }
    };
    try {
      let reply = await sendWithEffort(effort);
      if (!reply.text.trim()) {
        // Usually the reply hit the model's output limit while it was still thinking, which
        // high effort on a large request makes likely. Ask once more with less thinking.
        this.log?.warn(`${model.name} sent back no text: ${await this.describe(model, messages[0], reply, effort)}`);
        if (effort !== 'low' && !this.noEffort.has(model.id)) {
          reply = await sendWithEffort('low');
          if (!reply.text.trim()) this.log?.warn(`${model.name} sent back no text again: ${await this.describe(model, messages[0], reply, 'low')}`);
        }
        if (!reply.text.trim()) {
          throw new AIEmptyReplyError(
            `${model.name} sent back an empty reply. This usually means the reply hit the model's length limit, which large requests at high effort make likely. ` +
              `Try another model or a lower effort for the ${req.slot} slot with "codelearn: Choose AI models". Details are in the codelearn log.`,
          );
        }
      }
      return { text: reply.text, model: model.name, usage: await estimateUsage(model, messages[0], reply.text) };
    } catch (e) {
      throw friendlyError(e);
    } finally {
      cts?.dispose();
    }
  }

  /** What came back, for the log. Counts and sizes only: never the code or the reply. */
  private async describe(model: vscode.LanguageModelChat, prompt: vscode.LanguageModelChatMessage, reply: Reply, effort: Effort): Promise<string> {
    const parts = Object.entries(reply.parts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
    const tokens = await Promise.resolve(model.countTokens(prompt)).catch(() => undefined);
    const effortNote = this.noEffort.has(model.id) ? 'not supported' : effort;
    return `received ${parts} in ${Math.round(reply.ms / 1000)}s; prompt about ${tokens ?? '?'} of ${model.maxInputTokens} input tokens; effort ${effortNote}.`;
  }

  /** Models that rejected a reasoning effort this session. */
  private readonly noEffort = new Set<string>();
}

/**
 * VS Code merges `configuration` into the model's per-user settings (the effort chosen in the
 * chat model picker), and Copilot reads `reasoningEffort` from it. Not in the published API
 * typings yet; versions that don't know it ignore it, and the model then uses the picker's effort.
 */
type CopilotRequestOptions = vscode.LanguageModelChatRequestOptions & { configuration?: { reasoningEffort: string } };

interface Reply {
  text: string;
  /** How many parts of each kind the stream sent, e.g. text, thinking. */
  parts: Record<string, number>;
  ms: number;
}

function partKind(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) return 'text';
  if (part instanceof vscode.LanguageModelToolCallPart) return 'tool call';
  const name = (part as object | undefined)?.constructor?.name ?? typeof part;
  return name.replace(/^LanguageModel/, '').replace(/Part$/, '').toLowerCase() || 'other';
}

/** Copilot's models offer low, medium and high. */
export function copilotEffort(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

/** Errors that asking again without the effort setting won't fix. */
function isAccessError(e: unknown): boolean {
  if (e instanceof Error && (e.name === 'ChatQuotaExceeded' || e.name === 'ChatRateLimited')) return true;
  return (
    e instanceof vscode.LanguageModelError &&
    (e.code === vscode.LanguageModelError.NoPermissions.name || e.code === vscode.LanguageModelError.Blocked.name)
  );
}

function effortSetting(slot: Slot): string {
  return vscode.workspace.getConfiguration('codelearn').get<string>(`effort.${slot}`, 'auto');
}

/** Copilot doesn't report tokens, so count them with the model's own tokenizer. */
async function estimateUsage(model: vscode.LanguageModelChat, prompt: vscode.LanguageModelChatMessage, reply: string) {
  try {
    const [input, output] = await Promise.all([model.countTokens(prompt), model.countTokens(reply)]);
    return { input, output, exact: false };
  } catch {
    return undefined;
  }
}

function toInfo(m: vscode.LanguageModelChat): ModelInfo {
  return { id: m.id, name: m.name, family: m.family, vendor: m.vendor, maxInputTokens: m.maxInputTokens };
}

function settingFor(slot: Slot): string {
  return vscode.workspace.getConfiguration('codelearn').get<string>(`models.${slot}`, 'auto');
}

function friendlyError(e: unknown): Error {
  if (e instanceof vscode.LanguageModelError) {
    if (e.code === vscode.LanguageModelError.NoPermissions.name) {
      return new AIUnavailableError('codelearn is not allowed to use this model yet. Run the command again and choose Allow when VS Code asks.');
    }
    if (e.code === vscode.LanguageModelError.Blocked.name) {
      return new AIUnavailableError('The request was blocked, usually by a usage limit. Try again later or pick another model with "codelearn: Choose AI models".');
    }
    if (e.code === vscode.LanguageModelError.NotFound.name) {
      return new AIUnavailableError('The chosen model is no longer available. Pick another with "codelearn: Choose AI models".');
    }
  }
  return e instanceof Error ? e : new Error(String(e));
}
