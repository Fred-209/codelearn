import * as vscode from 'vscode';
import type { Citation } from '../store/types';
import { verifyAll, FileLookup } from './anchor';
import { LineSpan, Scope, scopeLadder, SymbolSpan } from './codeScope';

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

/** Waits for a language-extension command, giving up after `ms` (servers can be slow to start). */
export async function ask<T>(command: string, ms: number, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await Promise.race([
      vscode.commands.executeCommand<T>(command, ...args),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), ms)),
    ]);
  } catch {
    return undefined;
  }
}

const FUNCTION_KINDS = new Map<vscode.SymbolKind, string>([
  [vscode.SymbolKind.Function, 'function'],
  [vscode.SymbolKind.Method, 'method'],
  [vscode.SymbolKind.Constructor, 'constructor'],
  [vscode.SymbolKind.Property, 'property'],
  [vscode.SymbolKind.Operator, 'operator'],
  [vscode.SymbolKind.Event, 'event'],
]);
const TYPE_KINDS = new Map<vscode.SymbolKind, string>([
  [vscode.SymbolKind.Class, 'class'],
  [vscode.SymbolKind.Interface, 'interface'],
  [vscode.SymbolKind.Struct, 'struct'],
  [vscode.SymbolKind.Enum, 'enum'],
  [vscode.SymbolKind.Module, 'module'],
  [vscode.SymbolKind.Namespace, 'namespace'],
]);
/** Kinds that hold a function as often as not: `const handle = () => {...}`. Only multi-line ones count. */
const VALUE_KINDS = new Set([vscode.SymbolKind.Variable, vscode.SymbolKind.Constant, vscode.SymbolKind.Field]);

/**
 * The nested scopes around `pos`, from the language extension's "Expand selection" ranges and
 * outline, falling back to indentation when it offers neither.
 */
export async function scopesAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<Scope[]> {
  const [ranges, symbols] = await Promise.all([
    ask<vscode.SelectionRange[]>('vscode.executeSelectionRangeProvider', 2500, doc.uri, [pos]),
    ask<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', 2500, doc.uri),
  ]);

  const spans: LineSpan[] = [];
  for (let r: vscode.SelectionRange | undefined = ranges?.[0]; r; r = r.parent) {
    // A range ending at column 0 of a line really ends on the line before.
    const end = r.range.end.character === 0 && r.range.end.line > r.range.start.line ? r.range.end.line - 1 : r.range.end.line;
    spans.push({ start: r.range.start.line, end });
  }

  const syms: SymbolSpan[] = [];
  const add = (name: string, kind: vscode.SymbolKind, range: vscode.Range) => {
    if (!range.contains(pos)) return;
    const span = { start: range.start.line, end: range.end.line, name };
    if (FUNCTION_KINDS.has(kind)) syms.push({ ...span, word: FUNCTION_KINDS.get(kind)!, kind: 'function' });
    else if (TYPE_KINDS.has(kind)) syms.push({ ...span, word: TYPE_KINDS.get(kind)!, kind: 'type' });
    else if (VALUE_KINDS.has(kind) && span.end > span.start) syms.push({ ...span, word: '', kind: 'function' });
  };
  const visit = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      add(s.name, s.kind, s.range);
      if (s.children?.length) visit(s.children);
    }
  };
  for (const s of symbols ?? []) {
    if ('children' in s) visit([s]);
    else add(s.name, s.kind, s.location.range);
  }

  const lines = doc.getText().split(/\r?\n/);
  return scopeLadder(pos.line, lines, spans, syms);
}

/** A code region with real line numbers, for prompts. */
export function numberedRange(doc: vscode.TextDocument, startLine: number, endLine: number): string {
  const out: string[] = [];
  for (let i = Math.max(0, startLine); i <= Math.min(endLine, doc.lineCount - 1); i++) {
    out.push(`${i + 1}| ${doc.lineAt(i).text}`);
  }
  return out.join('\n');
}
