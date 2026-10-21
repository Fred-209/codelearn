import * as vscode from 'vscode';
import type { Citation } from '../store/types';
import { verifyAll, FileLookup } from './anchor';

export function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

export function uriFor(root: vscode.Uri, file: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...file.split('/'));
}

/** Current text of a workspace file, preferring unsaved editor contents. */
export async function readText(root: vscode.Uri, file: string): Promise<string | undefined> {
  const uri = uriFor(root, file);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Verifies citations against the files on disk (or in open editors). */
export async function verifyOnDisk(root: vscode.Uri, cs: Citation[]): Promise<Citation[]> {
  const texts = new Map<string, string[] | undefined>();
  for (const file of new Set(cs.map((c) => c.file))) {
    const t = await readText(root, file);
    texts.set(file, t?.split(/\r?\n/));
  }
  const lookup: FileLookup = (f) => texts.get(f);
  return verifyAll(cs, lookup);
}

/** Opens a file at a 1-based line, beside or in the current editor group. */
export async function openAt(root: vscode.Uri, file: string, line: number, column = vscode.ViewColumn.One): Promise<vscode.TextEditor | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uriFor(root, file));
    const pos = new vscode.Position(Math.max(0, Math.min(line - 1, doc.lineCount - 1)), 0);
    return await vscode.window.showTextDocument(doc, { viewColumn: column, selection: new vscode.Range(pos, pos), preview: true });
  } catch {
    vscode.window.showWarningMessage(`codelearn: couldn't open ${file}. It may have been moved or deleted.`);
    return undefined;
  }
}

/** The smallest function-like symbol containing `pos`, if a language extension provides symbols. */
export async function enclosingSymbol(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.DocumentSymbol | undefined> {
  let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    symbols = await Promise.race([
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500)),
    ]);
  } catch {
    return undefined;
  }
  const fnKinds = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Operator,
  ]);
  let best: vscode.DocumentSymbol | undefined;
  const visit = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      if (!s.range.contains(pos)) continue;
      if (fnKinds.has(s.kind) && (!best || best.range.contains(s.range))) best = s;
      if (s.children?.length) visit(s.children);
    }
  };
  if (symbols?.length && 'children' in symbols[0]) visit(symbols as vscode.DocumentSymbol[]);
  return best;
}

/** A code region with real line numbers, for prompts. */
export function numberedRange(doc: vscode.TextDocument, startLine: number, endLine: number): string {
  const out: string[] = [];
  for (let i = Math.max(0, startLine); i <= Math.min(endLine, doc.lineCount - 1); i++) {
    out.push(`${i + 1}| ${doc.lineAt(i).text}`);
  }
  return out.join('\n');
}
