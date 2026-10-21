import * as vscode from 'vscode';
import { Lookups, RepoLookup } from '../ai/lookups';
import { hash } from '../store/store';
import { collectFiles } from './collect';
import type { RepoFile } from './digest';
import { indexRepo, RepoIndex } from './repoIndex';

export interface Snapshot {
  files: RepoFile[];
  hashes: Record<string, string>;
  /** When the files were read. */
  at: number;
}

const MAX_AGE_MS = 3 * 60_000;

/**
 * The repo's readable files, kept in memory and shared: the map build, the changed-files check,
 * examples in lessons and AI lookups all use the same copy. Saved edits update it in place;
 * anything else (a pull, a branch switch) is picked up once the copy is a few minutes old.
 */
export class RepoFiles implements vscode.Disposable {
  private snap: Snapshot | undefined;
  private loading: Promise<Snapshot> | undefined;
  private readonly derived = new WeakMap<Snapshot, { index?: RepoIndex; lookup?: RepoLookup }>();
  private readonly subs: vscode.Disposable[];

  constructor(private readonly folder: vscode.WorkspaceFolder | undefined) {
    this.subs = [vscode.workspace.onDidSaveTextDocument((doc) => this.saved(doc))];
  }

  /** The files, read again when the copy is older than `maxAgeMs`. */
  async get(maxAgeMs = MAX_AGE_MS): Promise<Snapshot> {
    if (this.snap && Date.now() - this.snap.at < maxAgeMs) return this.snap;
    return this.refresh();
  }

  /** Reads every file again. Callers at the same time share one read. */
  refresh(): Promise<Snapshot> {
    if (this.loading) return this.loading;
    const folder = this.folder;
    if (!folder) return Promise.resolve({ files: [], hashes: {}, at: Date.now() });
    // Not cancelled by any one caller, since others may be waiting on the same read.
    const cts = new vscode.CancellationTokenSource();
    this.loading = collectFiles(folder, cts.token)
      .then(({ files, hashes }) => (this.snap = { files, hashes, at: Date.now() }))
      .finally(() => {
        this.loading = undefined;
        cts.dispose();
      });
    return this.loading;
  }

  index(snap: Snapshot): RepoIndex {
    const d = this.derivedOf(snap);
    return (d.index ??= indexRepo(snap.files));
  }

  lookup(snap: Snapshot): RepoLookup {
    const d = this.derivedOf(snap);
    return (d.lookup ??= new RepoLookup(snap.files));
  }

  /** Read-only lookups for one AI request, or undefined when they're off or `max` is 0. */
  async lookups(max: number): Promise<Lookups | undefined> {
    if (max <= 0 || !this.folder || !vscode.workspace.getConfiguration('codelearn').get<boolean>('ai.lookups', true)) return undefined;
    const lookup = this.lookup(await this.get());
    return {
      max,
      run: async (name, input) => lookup.run(name, input),
      root: this.folder.uri.scheme === 'file' ? this.folder.uri.fsPath : undefined,
    };
  }

  private derivedOf(snap: Snapshot): { index?: RepoIndex; lookup?: RepoLookup } {
    let d = this.derived.get(snap);
    if (!d) this.derived.set(snap, (d = {}));
    return d;
  }

  /** A saved file replaces its copy. New files wait for the next full read, which applies the excludes. */
  private saved(doc: vscode.TextDocument): void {
    const snap = this.snap;
    if (!snap || !this.folder) return;
    const path = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    if (!(path in snap.hashes)) return;
    const text = doc.getText();
    this.snap = {
      files: snap.files.map((f) => (f.path === path ? { path, text, size: text.length } : f)),
      hashes: { ...snap.hashes, [path]: hash(text) },
      at: snap.at,
    };
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
