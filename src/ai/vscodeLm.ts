import * as vscode from 'vscode';
import { AIEmptyReplyError, AIProvider, AIRequest, AIResult, AIUnavailableError, TokenUsage } from './provider';
import { LOOKUP_TOOLS, lookupNote, lookupRounds } from './lookups';
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
    return (await usableModels()).map(toInfo);
  }

  async modelFor(slot: Slot): Promise<ModelInfo | undefined> {
    const models = await this.listModels();
    return pickModel(models, slot, settingFor(slot));
  }

  async complete(req: AIRequest, token?: vscode.CancellationToken): Promise<AIResult> {
    const all = await usableModels();
    const info = pickModel(all.map(toInfo), req.slot, settingFor(req.slot));
    const model = info && all.find((m) => m.id === info.id);
    if (!model) {
      throw new AIUnavailableError(
        'No AI model is available. codelearn uses the models from GitHub Copilot: make sure Copilot Chat is installed and you are signed in.',
      );
    }

    // The Language Model API has no system role; instructions go first in the user turn.
    const lookups = req.lookups && req.lookups.max > 0 ? req.lookups : undefined;
    const note = lookups ? lookupNote(lookups.max, 'call the search, read_lines, list_folder and find_symbol tools.') : '';
    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(`${req.system}\n\n---\n\n${req.user}${note}`)];
    const tools = lookups ? LOOKUP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : undefined;
    const cts = token ? undefined : new vscode.CancellationTokenSource();
    const cancel = token ?? cts!.token;
    const effort = copilotEffort(effortFor(req.slot, effortSetting(req.slot)));
    const send = async (level: Effort | undefined): Promise<Reply> => {
      const options: CopilotRequestOptions = { justification: req.justification };
      if (level) options.configuration = { reasoningEffort: level };
      if (tools) options.tools = tools;
      const started = Date.now();
      const response = await model.sendRequest(messages, options, cancel);
      const reply: Reply = { text: '', calls: [], parts: {}, ms: 0 };
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) reply.text += part.value;
        else if (part instanceof vscode.LanguageModelToolCallPart) reply.calls.push(part);
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
      const sent = new SentTokens(model, messages[0]);
      await sent.round();
      let reply = await sendWithEffort(effort);
      if (!reply.text.trim() && reply.calls.length === 0) {
        // Nothing at all, straight away: the model ignored the request (or its settings).
        // Something after a while: usually the output limit was reached while it was still
        // thinking, which high effort on a large request makes likely.
        const instant = reply.ms < 3000 && !Object.keys(reply.parts).length;
        this.log?.warn(`${model.name} sent back no text: ${await this.describe(model, messages[0], reply, effort)}`);
        await sent.round();
        if (instant) {
          reply = await send(undefined);
        } else if (effort !== 'low' && !this.noEffort.has(model.id)) {
          reply = await sendWithEffort('low');
        }
        if (!reply.text.trim() && reply.calls.length === 0) {
          this.log?.warn(`${model.name} sent back no text again: ${await this.describe(model, messages[0], reply, instant ? undefined : 'low')}`);
          throw new AIEmptyReplyError(
            instant
              ? `${model.name} (${model.vendor}) answered instantly with nothing, so it doesn't seem to take requests from extensions. ` +
                  `Pick another model for the ${req.slot} slot with "codelearn: Choose AI models".`
              : `${model.name} sent back an empty reply. This usually means the reply hit the model's length limit, which large requests at high effort make likely. ` +
                  `Try another model or a lower effort for the ${req.slot} slot with "codelearn: Choose AI models". Details are in the codelearn log.`,
          );
        }
      }

      // Lookups: run what the model asked for, send the results back, and let it carry on.
      // Rounds are capped too, and the last one tells the model to answer with what it has.
      let used = 0;
      let rounds = 0;
      const maxRounds = lookups ? lookupRounds(lookups.max) + 1 : 0;
      while (lookups && reply.calls.length && rounds < maxRounds) {
        rounds++;
        const results: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
        for (const call of reply.calls) {
          const out = used < lookups.max ? (used++, await lookups.run(call.name, call.input)) : 'Not run: no lookups left. Answer with what you have.';
          results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(out)]));
          sent.add(JSON.stringify(call.input).length + out.length + 40);
        }
        const last = used >= lookups.max || rounds === maxRounds - 1;
        if (last) results.push(new vscode.LanguageModelTextPart('No more lookups: reply now with the final JSON only.'));
        messages.push(vscode.LanguageModelChatMessage.Assistant([...(reply.text ? [new vscode.LanguageModelTextPart(reply.text)] : []), ...reply.calls]));
        messages.push(vscode.LanguageModelChatMessage.User(results));
        sent.add(reply.text.length);
        await sent.round();
        reply = await sendWithEffort(effort);
      }
      if (!reply.text.trim()) {
        throw new AIEmptyReplyError(`${model.name} kept looking things up and never answered. Try again, or turn off codelearn.ai.lookups.`);
      }
      this.log?.info(
        `${req.purpose}: ${model.name} (${model.vendor}/${model.id}) replied with ${reply.text.length} characters in ${Math.round(reply.ms / 1000)}s` +
          `${used ? ` after ${used} lookups in ${rounds} rounds` : ''}.`,
      );
      return { text: reply.text, model: model.name, usage: await sent.usage(reply.text), ...(used ? { lookups: used } : {}) };
    } catch (e) {
      throw friendlyError(e);
    } finally {
      cts?.dispose();
    }
  }

  /** What came back, for the log. Counts and sizes only: never the code or the reply. */
  private async describe(model: vscode.LanguageModelChat, prompt: vscode.LanguageModelChatMessage, reply: Reply, effort: Effort | undefined): Promise<string> {
    const parts = Object.entries(reply.parts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
    const tokens = await Promise.resolve(model.countTokens(prompt)).catch(() => undefined);
    const effortNote = this.noEffort.has(model.id) ? 'not supported' : (effort ?? 'not sent');
    return `model ${model.vendor}/${model.id}; received ${parts} in ${(reply.ms / 1000).toFixed(1)}s; prompt about ${tokens ?? '?'} of ${model.maxInputTokens} input tokens; effort ${effortNote}.`;
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
  calls: vscode.LanguageModelToolCallPart[];
  /** How many parts of each kind the stream sent, e.g. text, thinking. */
  parts: Record<string, number>;
  ms: number;
}

/**
 * Tokens sent across every round of a request. Copilot doesn't report tokens, so the prompt is
 * counted with the model's own tokenizer (some count 0; then about 4 characters a token), and
 * what lookups add is estimated from its length. Each round sends the whole conversation again.
 */
class SentTokens {
  private base: number | undefined;
  private extraChars = 0;
  private total = 0;

  constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly prompt: vscode.LanguageModelChatMessage,
  ) {}

  /** A request is about to go out. */
  async round(): Promise<void> {
    if (this.base === undefined) {
      const counted = await Promise.resolve(this.model.countTokens(this.prompt)).catch(() => 0);
      this.base = counted > 0 ? counted : Math.ceil(textOf(this.prompt).length / 4);
    }
    this.total += this.base + Math.ceil(this.extraChars / 4);
  }

  /** Characters added to the conversation (tool calls, results, earlier replies). */
  add(chars: number): void {
    this.extraChars += chars;
  }

  async usage(reply: string): Promise<TokenUsage> {
    const counted = await Promise.resolve(this.model.countTokens(reply)).catch(() => 0);
    return { input: this.total, output: counted > 0 ? counted : Math.ceil(reply.length / 4), exact: false };
  }
}

function textOf(m: vscode.LanguageModelChatMessage): string {
  return m.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : '')).join('');
}

function partKind(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) return 'text';
  if (part instanceof vscode.LanguageModelToolCallPart) return 'tool call';
  const name = (part as object | undefined)?.constructor?.name ?? typeof part;
  return name.replace(/^LanguageModel/, '').replace(/Part$/, '').toLowerCase() || 'other';
}

/**
 * Models that answer requests from extensions. Copilot's own models come first. Some
 * providers list models only for their agent sessions and answer extension requests with
 * nothing: Copilot CLI ("copilotcli") lists Claude and GPT models that reply instantly and
 * empty, and count every prompt as 0 tokens.
 */
const SESSION_ONLY_VENDORS = new Set(['copilotcli']);

export async function usableModels(): Promise<vscode.LanguageModelChat[]> {
  const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (copilot.length) return copilot;
  return (await vscode.lm.selectChatModels()).filter((m) => !SESSION_ONLY_VENDORS.has(m.vendor));
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
