// Which AI provider serves requests. Pure, so it can be unit tested.

export type ProviderSetting = 'auto' | 'copilot' | 'claude-code';
export type ProviderId = 'copilot' | 'claude-code';

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  copilot: 'GitHub Copilot',
  'claude-code': 'Claude Code',
};

/**
 * "auto" prefers Copilot's models when VS Code offers any (the approved route at work),
 * then Claude Code when its command line is installed.
 */
export function chooseProvider(setting: string, hasCopilotModels: boolean, hasClaudeCode: boolean): ProviderId | undefined {
  if (setting === 'copilot' || setting === 'claude-code') return setting;
  if (hasCopilotModels) return 'copilot';
  if (hasClaudeCode) return 'claude-code';
  return undefined;
}

export const NO_PROVIDER_HELP =
  'No AI model is available. codelearn uses GitHub Copilot (install Copilot Chat and sign in) or Claude Code ' +
  '(install it and log in once with `claude` in a terminal). Pick one with "codelearn: Choose AI models".';
