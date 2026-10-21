import * as vscode from 'vscode';
import type { RepoMap } from '../store/types';
import { ask, relPath, scopesAt } from './files';
import { hoverPause } from './hoverPause';
import { placesFor, placesText } from './places';

// What the editor's language extensions already know about a piece of code: the scopes around
// it, its definition, the places that use it, and their hover text. Sent along with
// explanations so the AI isn't working from a dozen lines alone. No AI involved; every call is
// time-boxed, since language servers can be slow.

export interface Definition {
  /** Workspace-relative for repo files; a short name for library files. */
  file: string;
  line: number; // 1-based
  /** Numbered lines of the definition. */
  snippet: string;
  /** Defined in this repo (not a library or the platform). */
  inRepo: boolean;
  /** The definition is the very spot asked about. */
  here: boolean;
}

export function inRepo(uri: vscode.Uri): boolean {
  const root = vscode.workspace.getWorkspaceFolder(uri);
  return !!root && !/\/(node_modules|bin|obj|dist|out)\//.test(uri.path);
}

export async function definitionAt(doc: vscode.TextDocument, pos: vscode.Position, ms = 2500, maxLines = 14): Promise<Definition | undefined> {
  const found = await ask<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', ms, doc.uri, pos);
  const first = found?.[0];
  if (!first) return undefined;
  const uri = 'targetUri' in first ? first.targetUri : first.uri;
  const range = 'targetUri' in first ? first.targetRange : first.range;
  let lines: string[];
  try {
    lines = (await vscode.workspace.openTextDocument(uri)).getText().split(/\r?\n/);
  } catch {
    return undefined;
  }
  const start = range.start.line;
  const end = Math.min(range.end.line, start + maxLines - 1, lines.length - 1);
  const from = Math.max(0, start - 1);
  const snippet = lines
    .slice(from, end + 1)
    .map((l, i) => `${from + i + 1}| ${l.slice(0, 200)}`)
    .join('\n');
  const repo = inRepo(uri);
  return {
    file: repo ? relPath(uri) : uri.path.split('/').slice(-2).join('/'),
    line: start + 1,
    snippet,
    inRepo: repo,
    here: uri.toString() === doc.uri.toString() && start <= pos.line && range.end.line >= pos.line,
  };
}

/** Up to `max` places that use the symbol, one per file first, excluding the spot itself. */
export async function referencesTo(doc: vscode.TextDocument, pos: vscode.Position, max = 6, ms = 3000): Promise<{ file: string; line: number; text: string }[]> {
  const found = (await ask<vscode.Location[]>('vscode.executeReferenceProvider', ms, doc.uri, pos)) ?? [];
  const others = found.filter((l) => !(l.uri.toString() === doc.uri.toString() && l.range.start.line === pos.line) && inRepo(l.uri));
  const byFile = new Map<string, vscode.Location[]>();
  for (const l of others) byFile.set(l.uri.toString(), [...(byFile.get(l.uri.toString()) ?? []), l]);
  // One from each file first, then seconds.
  const picked: vscode.Location[] = [];
  for (let round = 0; picked.length < max && round < 3; round++) {
    for (const list of byFile.values()) if (list[round] && picked.length < max) picked.push(list[round]);
  }
  const out: { file: string; line: number; text: string }[] = [];
  for (const l of picked) {
    try {
      const d = await vscode.workspace.openTextDocument(l.uri);
      out.push({ file: relPath(l.uri), line: l.range.start.line + 1, text: d.lineAt(l.range.start.line).text.trim().slice(0, 200) });
    } catch {
      // moved or unreadable
    }
  }
  return out;
}

/** What the other extensions show on hover here (types, signatures, docs), not codelearn's own. */
export async function otherHovers(doc: vscode.TextDocument, pos: vscode.Position, ms = 2000): Promise<string> {
  hoverPause.count++;
  try {
    const hovers = (await ask<vscode.Hover[]>('vscode.executeHoverProvider', ms, doc.uri, pos)) ?? [];
    const texts = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
      .filter((t) => t.trim() && !/codelearn/i.test(t));
    return texts.join('\n\n').slice(0, 1500);
  } finally {
    hoverPause.count--;
  }
}

/** "class Create > class Command (lines 15-30)": the named scopes around a line. */
export async function enclosing(doc: vscode.TextDocument, pos: vscode.Position): Promise<string> {
  const ladder = await scopesAt(doc, pos);
  const named = ladder.filter((s) => s.kind !== 'block' && s.label && !(s.start === pos.line && s.end === pos.line));
  if (named.length === 0) return '';
  return named
    .reverse()
    .map((s) => `${s.label} (lines ${s.start + 1}-${s.end + 1})`)
    .join(' > ');
}

const NOT_CALLS = new Set(
  'if for foreach while switch catch return function typeof sizeof nameof await new using lock fixed checked unchecked default when and or not in of is as do else try throw yield super this base'.split(' '),
);

/** Definitions of the functions and types used in lines `start`-`end` (0-based) that live elsewhere. */
export async function calledDefinitions(doc: vscode.TextDocument, start: number, end: number, max = 5): Promise<string> {
  const seen = new Map<string, vscode.Position>();
  const call = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()\n]*>)?\s*\(|\bnew\s+([A-Z][\w$]*)/g;
  for (let i = start; i <= Math.min(end, doc.lineCount - 1) && seen.size < 10; i++) {
    const text = doc.lineAt(i).text;
    for (const m of text.matchAll(call)) {
      const name = m[1] ?? m[2];
      if (!name || NOT_CALLS.has(name) || seen.has(name)) continue;
      seen.set(name, new vscode.Position(i, (m.index ?? 0) + m[0].indexOf(name)));
    }
  }
  const defs = await Promise.all(
    [...seen].map(async ([name, pos]) => {
      const d = await definitionAt(doc, pos, 2000, 12);
      const insideRange = d && d.file === relPath(doc.uri) && d.line - 1 >= start && d.line - 1 <= end;
      return d && !d.here && !insideRange ? { name, d } : undefined;
    }),
  );
  const found = defs.filter((x): x is { name: string; d: Definition } => !!x);
  // This repo's own code first: library signatures matter less.
  found.sort((a, b) => Number(b.d.inRepo) - Number(a.d.inRepo));
  if (found.length === 0) return '';
  return `Definitions of names used here (from the language extension):\n${found
    .slice(0, max)
    .map(({ name, d }) => `${name}, defined in ${d.file}:${d.line}${d.inRepo ? '' : ' (a library)'}:\n\`\`\`\n${d.snippet}\n\`\`\``)
    .join('\n')}`;
}

export interface QuickContext {
  text: string;
  /** The word is defined in this repo, so what it means depends on where it is. */
  repoSymbol: boolean;
}

/** Everything the editor knows about one word, for a quick explanation. */
export async function quickContext(doc: vscode.TextDocument, pos: vscode.Position, map: RepoMap | undefined): Promise<QuickContext> {
  const [scope, hover, def, refs] = await Promise.all([
    enclosing(doc, pos).catch(() => ''),
    otherHovers(doc, pos).catch(() => ''),
    definitionAt(doc, pos).catch(() => undefined),
    referencesTo(doc, pos).catch(() => []),
  ]);
  const parts: string[] = [];
  if (scope) parts.push(`It is inside: ${scope}.`);
  if (hover) parts.push(`What the language extension says about it:\n${hover}`);
  if (def && !def.here) parts.push(`Defined in ${def.file}:${def.line}${def.inRepo ? '' : ' (a library)'}:\n\`\`\`\n${def.snippet}\n\`\`\``);
  if (refs.length) parts.push(`Places that use it (from Find References):\n${refs.map((r) => `- ${r.file}:${r.line}: ${r.text}`).join('\n')}`);
  if (map) {
    const where = placesText(placesFor(map, relPath(doc.uri)));
    if (where) parts.push(where);
  }
  return { text: parts.join('\n\n'), repoSymbol: !!def?.inRepo };
}
