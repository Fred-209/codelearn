import * as vscode from 'vscode';
import { AIProvider, AIRequest, AIResult, AIUnavailableError } from './provider';
import { ModelInfo, pickModel, Slot } from './modelPick';

/**
 * Uses the models VS Code exposes to extensions (GitHub Copilot's, including the
 * Claude models Copilot offers). No API key: requests go wherever Copilot sends them.
 */
export class VsCodeLmProvider implements AIProvider {
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
    try {
      const response = await model.sendRequest(messages, { justification: req.justification }, token ?? cts!.token);
      let text = '';
      for await (const chunk of response.text) text += chunk;
      return { text, model: model.name, usage: await estimateUsage(model, messages[0], text) };
    } catch (e) {
      throw friendlyError(e);
    } finally {
      cts?.dispose();
    }
  }
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
