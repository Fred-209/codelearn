import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { citations, obj, slug, str, strs } from '../ai/normalize';
import { explainPrompt, quickExplainPrompt, Zoom } from '../ai/prompts';
import type { Services } from '../services';
import { hash } from '../store/store';
import type { Explanation, RepoMap } from '../store/types';
import { numberedRange, scopesAt, readText, relPath, verifyOnDisk } from './files';
import { numbered } from '../scan/digest';
import { defaultScope, enclosingLabel, Scope } from './codeScope';
import { calledDefinitions, quickContext } from './codeContext';
import { placesFor, placesText } from './places';

/** Lookups for "What's happening here?": a few, to check what the code around doesn't show. */
const EXPLAIN_LOOKUPS = 6;

function normalizeExplanation(v: unknown, model: string): Explanation {
  const o = obj(v);
  const body = str(o.body);
  if (!body) throw new Error('The AI reply had no explanation.');
  return {
    title: str(o.title) || 'Explanation',
    body,
    conceptIds: strs(o.conceptIds).map(slug).slice(0, 12),
    citations: citations(o.citations),
    generatedAt: new Date().toISOString(),
    model,
  };
}

export interface ExplainTarget {
  uri: vscode.Uri;
  /** 0-based inclusive line range the learner is asking about. */
  startLine: number;
  endLine: number;
  /** The exact text the learner selected, when it is only part of those lines. */
  focus?: string;
  /** What the range is, e.g. "method GetActivePayments". */
  label?: string;
  /** The named scope around it, for context: "class PaymentService, lines 1-200". */
  within?: string;
  /** When picked from the cursor: the scopes around it, for Smaller and Larger. */
  ladder?: Scope[];
  scope?: number;
}

export class Explainer {
  constructor(private readonly s: Services) {}

  /** The code region "this line" means: the selection, else the scope around the cursor (see codeScope.ts). */
  static targetFor(editor: vscode.TextEditor): Promise<ExplainTarget> {
    return Explainer.targetAt(editor.document, editor.selection.active, editor.selection);
  }

  static async targetAt(doc: vscode.TextDocument, pos: vscode.Position, selection?: vscode.Selection): Promise<ExplainTarget> {
    if (selection && !selection.isEmpty) return Explainer.targetForRange(doc, selection);
    const ladder = await scopesAt(doc, pos);
    return Explainer.atScope(doc.uri, ladder, defaultScope(ladder));
  }

  /** Rung `index` of a ladder, e.g. one step smaller or larger than what was shown. */
  static atScope(uri: vscode.Uri, ladder: Scope[], index: number): ExplainTarget {
    const i = Math.max(0, Math.min(index, ladder.length - 1));
    const s = ladder[i];
    return { uri, startLine: s.start, endLine: s.end, label: s.label, within: enclosingLabel(ladder, i), ladder, scope: i };
  }

  /** A selected range. Keeps the exact selected text when it is only part of its lines. */
  static targetForRange(doc: vscode.TextDocument, range: vscode.Range): ExplainTarget {
    const startLine = range.start.line;
    const endLine = range.end.character === 0 && range.end.line > startLine ? range.end.line - 1 : range.end.line;
    const selected = doc.getText(range).trim();
    const whole = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)).trim();
    const focus = selected && selected !== whole && selected.length <= 2000 ? selected : undefined;
    return { uri: doc.uri, startLine, endLine, focus };
  }

  cacheKey(zoom: Zoom, target: ExplainTarget, doc: vscode.TextDocument): string {
    const file = relPath(target.uri);
    const code = zoom === 'line' ? numberedRange(doc, target.startLine, target.endLine) + (target.focus ? `\n${target.focus}` : '') : doc.getText();
    return `explain|${zoom}|${file}|${hash(code)}|${this.s.store.profileHash()}`;
  }

  async cached(zoom: Zoom, target: ExplainTarget): Promise<Explanation | undefined> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    return this.s.store.getExplanation(this.cacheKey(zoom, target, doc));
  }

  async explain(zoom: Zoom, target: ExplainTarget, token?: vscode.CancellationToken): Promise<Explanation> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const key = this.cacheKey(zoom, target, doc);
    const file = relPath(target.uri);
    const map = await this.s.store.getMap();

    let code: string;
    let extra = '';
    const where = map ? placesText(placesFor(map, file)) : '';
    if (zoom === 'line') {
      code = numberedRange(doc, target.startLine, target.endLine);
      extra = `The learner is looking at lines ${target.startLine + 1}-${target.endLine + 1}.`;
      if (target.within) extra += ` This code is inside ${target.within}.`;
      if (target.focus) extra += ` They selected exactly this part, so focus on it:\n\`\`\`\n${target.focus}\n\`\`\``;
      extra += `\nFile context (start of file):\n${numbered(doc.getText(), 25)}`;
      const defs = await calledDefinitions(doc, target.startLine, target.endLine).catch(() => '');
      if (defs) extra += `\n\n${defs}`;
    } else if (zoom === 'file') {
      code = clip(numbered(doc.getText(), 800), 45_000);
      extra = await this.neighbours(file);
    } else {
      code = clip(numbered(doc.getText(), 250), 20_000);
      extra = await this.flowContext(file, map);
    }
    if (where) extra = `${where}\n${extra}`;

    const { value, model } = await completeJson(
      this.s.ai,
      {
        slot: zoom === 'flow' ? 'deep' : 'standard',
        ...explainPrompt(zoom, file, code, extra, map, this.s.store.getProfile()),
        justification: 'codelearn explains the code you are reading.',
        purpose: `explain ${zoom === 'line' ? 'code' : zoom}: ${file}`,
        lookups: await this.s.files.lookups(EXPLAIN_LOOKUPS),
      },
      (v) => v,
      token,
    );
    const e = normalizeExplanation(value, model);
    if (this.s.store.root) e.citations = await verifyOnDisk(this.s.store.root, e.citations);
    await this.s.store.saveExplanation(key, e);
    return e;
  }

  /**
   * Short explanation of one word the map doesn't know, using the Fast model. Along with the code
   * around it goes what the language extension knows: the scopes around it, its definition, places
   * that use it and its hover text. Names defined in this repo are saved per file (the same name
   * can mean different things in different classes); library names per word and file type.
   */
  async quick(word: string, uri: vscode.Uri, line: number, token?: vscode.CancellationToken): Promise<Explanation> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.lineAt(Math.max(0, Math.min(line - 1, doc.lineCount - 1))).text;
    const col = Math.max(0, wordColumn(text, word));
    const pos = new vscode.Position(Math.max(0, Math.min(line - 1, doc.lineCount - 1)), col);
    const ctx = await quickContext(doc, pos, await this.s.store.getMap());
    const context = numberedRange(doc, line - 9, line + 7);
    const { value, model } = await completeJson(
      this.s.ai,
      {
        slot: 'fast',
        ...quickExplainPrompt(word, relPath(uri), context, this.s.store.getProfile(), ctx.text),
        justification: 'codelearn explains the code you are reading.',
        purpose: `quick explain: ${word}`,
      },
      (v) => v,
      token,
    );
    const e = normalizeExplanation(value, model);
    if (this.s.store.root) e.citations = await verifyOnDisk(this.s.store.root, e.citations);
    await this.s.store.saveExplanation(ctx.repoSymbol ? this.fileKey(word, uri) : this.wordKey(word, uri), e);
    return e;
  }

  /** For names from libraries and the language: the same everywhere in files of one type. */
  private wordKey(word: string, uri: vscode.Uri): string {
    const ext = uri.path.split('.').pop() ?? '';
    return `word2|${ext}|${word}|${this.s.store.profileHash()}`;
  }

  /** For names defined in this repo: per file. */
  private fileKey(word: string, uri: vscode.Uri): string {
    return `word2|file:${relPath(uri)}|${word}|${this.s.store.profileHash()}`;
  }

  async getQuickCached(word: string, uri: vscode.Uri): Promise<Explanation | undefined> {
    return (await this.s.store.getExplanation(this.fileKey(word, uri))) ?? this.s.store.getExplanation(this.wordKey(word, uri));
  }

  /** The files this one uses and the files that use it, from the repo's import graph. */
  private async neighbours(file: string): Promise<string> {
    const snap = await this.s.files.get();
    const index = this.s.files.index(snap);
    const uses = [...(index.imports.get(file) ?? [])].slice(0, 15);
    const usedBy = [...(index.importedBy.get(file) ?? [])].slice(0, 15);
    const parts: string[] = [];
    if (usedBy.length) parts.push(`Files that use this file: ${usedBy.join(', ')}${(index.importedBy.get(file)?.size ?? 0) > usedBy.length ? ', …' : ''}`);
    if (uses.length) parts.push(`Files this file uses: ${uses.join(', ')}`);
    return parts.join('\n');
  }

  private async flowContext(file: string, map: RepoMap | undefined): Promise<string> {
    if (!map) return `No repo map yet; infer the flow from the code and its imports.\n${await this.neighbours(file)}`;
    const flows = map.flows.filter((f) => f.files.includes(file) || f.steps?.some((s) => s.file === file));
    const parts = [
      'Flows in this repo:',
      ...map.flows.map((f) => `- ${f.name}: ${f.summary} Files: ${f.files.join(' -> ')}`),
    ];
    for (const f of flows.filter((x) => x.steps?.length).slice(0, 2)) {
      parts.push(`\nThe flow "${f.name}", step by step:\n${f.steps!.map((st, i) => `${i + 1}. ${st.file}:${st.line} ${st.title}`).join('\n')}`);
    }
    if (flows.length === 0) parts.push(await this.neighbours(file));
    const root = this.s.store.root;
    const related = (flows[0]?.files ?? []).filter((f) => f !== file).slice(0, 3);
    if (root) {
      for (const f of related) {
        const text = await readText(root, f);
        if (text) parts.push(`\nRelated file ${f}:\n\`\`\`\n${clip(numbered(text, 80), 6000)}\n\`\`\``);
      }
    }
    return parts.join('\n');
  }
}

/** Where the word starts on its line, as a whole word. */
function wordColumn(line: string, word: string): number {
  const m = new RegExp(`(^|[^\\w$])${word.replace(/[$]/g, '\\$')}(?![\\w$])`).exec(line);
  return m ? m.index + m[1].length : line.indexOf(word);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}
