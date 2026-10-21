import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { citations, obj, slug, str, strs } from '../ai/normalize';
import { explainPrompt, quickExplainPrompt, Zoom } from '../ai/prompts';
import type { Services } from '../services';
import { hash } from '../store/store';
import type { Explanation, RepoMap } from '../store/types';
import { enclosingSymbol, numberedRange, readText, relPath, verifyOnDisk } from './files';
import { numbered } from '../scan/digest';

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
}

export class Explainer {
  constructor(private readonly s: Services) {}

  /** The code region "this line" means: the selection, else the enclosing function, else nearby lines. */
  static targetFor(editor: vscode.TextEditor): Promise<ExplainTarget> {
    return Explainer.targetAt(editor.document, editor.selection.active, editor.selection);
  }

  static async targetAt(doc: vscode.TextDocument, pos: vscode.Position, selection?: vscode.Selection): Promise<ExplainTarget> {
    if (selection && !selection.isEmpty) return Explainer.targetForRange(doc, selection);
    const sym = await enclosingSymbol(doc, pos);
    if (sym && sym.range.end.line - sym.range.start.line < 120) {
      return { uri: doc.uri, startLine: sym.range.start.line, endLine: sym.range.end.line };
    }
    return { uri: doc.uri, startLine: Math.max(0, pos.line - 12), endLine: Math.min(doc.lineCount - 1, pos.line + 12) };
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
    if (zoom === 'line') {
      code = numberedRange(doc, target.startLine, target.endLine);
      extra = `The learner is looking at lines ${target.startLine + 1}-${target.endLine + 1}.`;
      if (target.focus) extra += ` They selected exactly this part, so focus on it:\n\`\`\`\n${target.focus}\n\`\`\``;
      extra += `\nFile context (start of file):\n${numbered(doc.getText(), 25)}`;
    } else if (zoom === 'file') {
      code = clip(numbered(doc.getText(), 800), 45_000);
    } else {
      code = clip(numbered(doc.getText(), 250), 20_000);
      extra = await this.flowContext(file, map);
    }

    const { value, model } = await completeJson(
      this.s.ai,
      {
        slot: zoom === 'flow' ? 'deep' : 'standard',
        ...explainPrompt(zoom, file, code, extra, map, this.s.store.getProfile()),
        justification: 'codelearn explains the code you are reading.',
        purpose: `explain ${zoom === 'line' ? 'code' : zoom}: ${file}`,
      },
      (v) => v,
      token,
    );
    const e = normalizeExplanation(value, model);
    if (this.s.store.root) e.citations = await verifyOnDisk(this.s.store.root, e.citations);
    await this.s.store.saveExplanation(key, e);
    return e;
  }

  /** Short explanation of one word the map doesn't know, using the Fast model. Saved per word and file type. */
  async quick(word: string, uri: vscode.Uri, line: number, token?: vscode.CancellationToken): Promise<Explanation> {
    const key = this.quickKey(word, uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const context = numberedRange(doc, line - 6, line + 6);
    const { value, model } = await completeJson(
      this.s.ai,
      { slot: 'fast', ...quickExplainPrompt(word, relPath(uri), context, this.s.store.getProfile()), justification: 'codelearn explains the code you are reading.', purpose: `quick explain: ${word}` },
      (v) => v,
      token,
    );
    const e = normalizeExplanation(value, model);
    if (this.s.store.root) e.citations = await verifyOnDisk(this.s.store.root, e.citations);
    await this.s.store.saveExplanation(key, e);
    return e;
  }

  quickKey(word: string, uri: vscode.Uri): string {
    const ext = uri.path.split('.').pop() ?? '';
    return `word|${ext}|${word}|${this.s.store.profileHash()}`;
  }

  getQuickCached(word: string, uri: vscode.Uri): Promise<Explanation | undefined> {
    return this.s.store.getExplanation(this.quickKey(word, uri));
  }

  private async flowContext(file: string, map: RepoMap | undefined): Promise<string> {
    if (!map) return 'No repo map yet; infer the flow from the code and its imports.';
    const flows = map.flows.filter((f) => f.files.includes(file));
    const parts = [
      'Flows in this repo:',
      ...map.flows.map((f) => `- ${f.name}: ${f.summary} Files: ${f.files.join(' -> ')}`),
    ];
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

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}
