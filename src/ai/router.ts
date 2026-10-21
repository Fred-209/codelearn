import * as vscode from 'vscode';
import { ClaudeCodeProvider } from './claudeCode';
import type { ModelInfo, Slot } from './modelPick';
import { AIProvider, AIRequest, AIResult, AIUnavailableError } from './provider';
import { chooseProvider, NO_PROVIDER_HELP, PROVIDER_NAMES, ProviderId } from './providerChoice';
import { VsCodeLmProvider } from './vscodeLm';
import type { UsageEntry } from '../store/usageReport';

/** Sends each request to the provider chosen by codelearn.provider. */
export class ProviderRouter implements AIProvider {
  readonly copilot = new VsCodeLmProvider();
  readonly claude: ClaudeCodeProvider;

  constructor(
    context: vscode.ExtensionContext,
    /** Called after every successful request, for the usage tally. */
    private readonly onUsage?: (entry: Omit<UsageEntry, 'repo'>) => void,
  ) {
    this.claude = new ClaudeCodeProvider(vscode.Uri.joinPath(context.globalStorageUri, 'claude-code'));
  }

  /** The provider that would serve a request right now, if any. */
  async current(): Promise<ProviderId | undefined> {
    const setting = vscode.workspace.getConfiguration('codelearn').get<string>('provider', 'auto');
    if (setting !== 'auto') return chooseProvider(setting, false, false);
    const hasCopilot = (await this.copilot.listModels().catch(() => [])).length > 0;
    return chooseProvider(setting, hasCopilot, !hasCopilot && (await this.claude.available()));
  }

  async name(): Promise<string> {
    const id = await this.current();
    return id ? PROVIDER_NAMES[id] : 'no AI provider';
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.target())?.listModels() ?? [];
  }

  async modelFor(slot: Slot): Promise<ModelInfo | undefined> {
    return (await this.target())?.modelFor(slot);
  }

  async complete(req: AIRequest, token?: vscode.CancellationToken): Promise<AIResult> {
    const id = await this.current();
    const target = id === 'copilot' ? this.copilot : id === 'claude-code' ? this.claude : undefined;
    if (!id || !target) throw new AIUnavailableError(NO_PROVIDER_HELP);
    const result = await target.complete(req, token);
    this.onUsage?.({
      at: new Date().toISOString(),
      provider: PROVIDER_NAMES[id],
      model: result.model,
      slot: req.slot,
      purpose: req.purpose,
      input: result.usage?.input,
      output: result.usage?.output,
      exact: result.usage?.exact ?? false,
      costUSD: result.usage?.costUSD,
    });
    return result;
  }

  private async target(): Promise<AIProvider | undefined> {
    const id = await this.current();
    return id === 'copilot' ? this.copilot : id === 'claude-code' ? this.claude : undefined;
  }
}
