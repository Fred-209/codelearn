import * as vscode from 'vscode';
import { classify, sampleOrder } from './classify';
import type { RepoFile } from './digest';
import { hash } from '../store/store';

const MAX_FILE_BYTES = 300_000;

export interface Collected {
  files: RepoFile[];
  hashes: Record<string, string>;
}

/** Reads the files worth learning from: code, instruction files and manifests. */
export async function collectFiles(folder: vscode.WorkspaceFolder, token: vscode.CancellationToken): Promise<Collected> {
  const cfg = vscode.workspace.getConfiguration('codelearn');
  const maxFiles = cfg.get<number>('scan.maxFiles', 1500);
  const exclude = cfg.get<string[]>('scan.exclude', []);
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*'),
    exclude.length ? `{${exclude.join(',')}}` : undefined,
    Math.min(maxFiles * 4, 20_000),
    token,
  );

  const rank = { instruction: 0, manifest: 1, code: 2, other: 3 } as const;
  const candidates = uris
    .map((uri) => ({ uri, path: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/') }))
    .map((c) => ({ ...c, role: classify(c.path) }))
    .filter((c) => c.role !== 'other')
    .sort((a, b) => rank[a.role] - rank[b.role] || a.path.localeCompare(b.path))
    .slice(0, maxFiles);

  const files: RepoFile[] = [];
  const hashes: Record<string, string> = {};
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const c of candidates) {
    if (token.isCancellationRequested) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(c.uri);
      if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) continue;
      const text = decoder.decode(bytes);
      files.push({ path: c.path, text, size: bytes.byteLength });
      hashes[c.path] = hash(text);
    } catch {
      // unreadable; skip
    }
  }
  return { files, hashes };
}

/**
 * Adds symbol outlines from installed language extensions to the files most likely
 * to be sampled. Language servers can be slow to start, so this is time-boxed.
 */
export async function addOutlines(folder: vscode.WorkspaceFolder, files: RepoFile[], token: vscode.CancellationToken, budgetMs = 20_000): Promise<void> {
  const code = files.filter((f) => classify(f.path) === 'code');
  const order = sampleOrder(code.map((f) => ({ path: f.path, size: f.size }))).slice(0, 60);
  const byPath = new Map(code.map((f) => [f.path, f]));
  const deadline = Date.now() + budgetMs;
  for (const path of order) {
    if (token.isCancellationRequested || Date.now() > deadline) return;
    const uri = vscode.Uri.joinPath(folder.uri, path);
    const symbols = await withTimeout(
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri),
      Math.min(3000, deadline - Date.now()),
    );
    if (symbols?.length) byPath.get(path)!.outline = flattenSymbols(symbols).slice(0, 60);
  }
}

export function flattenSymbols(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth = 0): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const range = 'range' in s ? s.range : s.location.range;
    out.push(`${range.start.line + 1}: ${'  '.repeat(depth)}${vscode.SymbolKind[s.kind]} ${s.name}`);
    if ('children' in s && s.children?.length && depth < 2) out.push(...flattenSymbols(s.children, depth + 1));
  }
  return out;
}

async function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  return Promise.race([
    Promise.resolve(p).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}
