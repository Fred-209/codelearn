import * as vscode from 'vscode';
import type { AIProvider } from './ai/provider';
import { AIUnavailableError } from './ai/provider';
import type { RepoFiles } from './scan/repoFiles';
import type { Store } from './store/store';

/** Shared by every feature. */
export interface Services {
  context: vscode.ExtensionContext;
  store: Store;
  ai: AIProvider;
  log: vscode.LogOutputChannel;
  /** The repo's readable files, in memory. */
  files: RepoFiles;
}

/** Shows an error the learner can act on, and logs the details. */
export function reportError(services: Services, what: string, e: unknown): void {
  if (e instanceof vscode.CancellationError || (e instanceof Error && e.name === 'Canceled')) return;
  const message = e instanceof Error ? e.message : String(e);
  services.log.error(`${what}: ${message}`, e instanceof Error ? e.stack : undefined);
  const actions = e instanceof AIUnavailableError ? ['Choose AI models'] : ['Show log'];
  vscode.window.showErrorMessage(`codelearn: ${what}. ${message}`, ...actions).then((choice) => {
    if (choice === 'Choose AI models') vscode.commands.executeCommand('codelearn.chooseModels');
    if (choice === 'Show log') services.log.show();
  });
}
