import * as vscode from 'vscode';
import type { UsageEntry } from './usageReport';

const MAX_ENTRIES = 5000;

/** Every AI request codelearn makes, kept in a file in its private storage on this machine. */
export class UsageLog {
  private readonly file: vscode.Uri;
  private writing: Promise<void> = Promise.resolve();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(storage: vscode.Uri) {
    this.file = vscode.Uri.joinPath(storage, 'usage.json');
  }

  async all(): Promise<UsageEntry[]> {
    await this.writing;
    return this.read();
  }

  record(entry: UsageEntry): Promise<void> {
    // Serialised so two requests finishing together don't overwrite each other.
    this.writing = this.writing.then(async () => {
      const entries = await this.read();
      entries.push(entry);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
      await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(JSON.stringify(entries.slice(-MAX_ENTRIES))));
      this.changed.fire();
    }).catch(() => undefined);
    return this.writing;
  }

  async clear(): Promise<void> {
    this.writing = this.writing.then(() => vscode.workspace.fs.delete(this.file)).catch(() => undefined);
    await this.writing;
    this.changed.fire();
  }

  private async read(): Promise<UsageEntry[]> {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file)));
      return Array.isArray(parsed) ? (parsed as UsageEntry[]) : [];
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
