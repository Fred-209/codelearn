import * as vscode from 'vscode';
import type { Services } from '../services';
import type { Concept, GlossaryTerm, RepoMap } from '../store/types';
import { commandLink } from '../ui/links';
import { trustLevel } from './anchor';
import { Explainer } from './explain';
import { worthExplaining } from './hoverFilter';
import { ConceptIndex, matchGlossary, matchTokens } from './matcher';

const COMMANDS = [
  'codelearn.openLesson',
  'codelearn.setConceptStatus',
  'codelearn.reportWrong',
  'codelearn.explainWord',
  'codelearn.stepThrough',
  'codelearn.whatsHappening',
  'codelearn.openMapItem',
  'codelearn.explainRange',
];

/**
 * Teaching hovers. Reads only what the map already holds, so hovering is instant and
 * makes no AI requests, unless the learner turns on codelearn.hover.autoGenerate.
 * Hovering inside a selection is about the whole selection, not the word under the mouse.
 */
export class TeachingHover implements vscode.HoverProvider {
  private index: ConceptIndex | undefined;
  private indexedMap: RepoMap | undefined;

  constructor(
    private readonly s: Services,
    private readonly explainer: Explainer,
  ) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const cfg = vscode.workspace.getConfiguration('codelearn');
    if (!cfg.get<boolean>('hover.enabled', true)) return undefined;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled' && doc.uri.scheme !== 'vscode-remote') return undefined;

    const map = await this.s.store.getMap();
    const md = newMarkdown();

    const selection = selectionAt(doc, pos);
    if (selection) {
      await this.selectionHover(md, doc, selection, map);
      return new vscode.Hover(md, selection);
    }

    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!range) return undefined;
    const word = doc.getText(range);

    if (map) {
      const concept = this.lookup(map, word)[0];
      if (concept) {
        conceptHover(md, concept, this.s.store.getStatus(concept.name), [doc.uri.toString(), pos.line + 1]);
        return new vscode.Hover(md, range);
      }
      const term = matchGlossary(word, map.glossary);
      if (term) {
        termHover(md, term);
        return new vscode.Hover(md, range);
      }
    }

    if (!cfg.get<boolean>('hover.showForUnknown', true)) return undefined;
    // Plain English words, comments and strings: nothing worth an AI request.
    if (!worthExplaining(word, doc.lineAt(pos.line).text, range.start.character)) return undefined;
    const args = [word, doc.uri.toString(), pos.line + 1];
    const cached = await this.explainer.getQuickCached(word, doc.uri);
    if (cached) {
      md.appendMarkdown(`**${escapeMd(cached.title)}** · _codelearn_\n\n${cached.body}\n\n`);
      md.appendMarkdown(commandLink('Explain this code', 'codelearn.whatsHappening'));
      return new vscode.Hover(md, range);
    }
    if (cfg.get<boolean>('hover.autoGenerate', false)) {
      try {
        const e = await this.explainer.quick(word, doc.uri, pos.line + 1, token);
        md.appendMarkdown(`**${escapeMd(e.title)}** · _codelearn_\n\n${e.body}`);
        return new vscode.Hover(md, range);
      } catch {
        // fall through to the link
      }
    }
    md.appendMarkdown(
      `$(book) ${commandLink(`codelearn: explain \`${word}\``, 'codelearn.explainWord', args, 'Uses one AI request; the answer is saved')}`,
    );
    return new vscode.Hover(md, range);
  }

  private async selectionHover(md: vscode.MarkdownString, doc: vscode.TextDocument, sel: vscode.Range, map: RepoMap | undefined): Promise<void> {
    const target = Explainer.targetForRange(doc, sel);
    const lines = target.startLine === target.endLine ? `line ${target.startLine + 1}` : `lines ${target.startLine + 1}–${target.endLine + 1}`;
    md.appendMarkdown(`**Your selection** · ${lines}\n\n`);

    if (map) {
      const words = [...new Set(matchTokens(doc.getText(sel)))];
      const concepts = [...new Set(words.flatMap((w) => this.lookup(map, w).slice(0, 1)))].slice(0, 8);
      const terms = [...new Set(words.map((w) => matchGlossary(w, map.glossary)).filter((t): t is GlossaryTerm => !!t))].slice(0, 5);
      const found = [
        ...concepts.map((c) => commandLink(c.name, 'codelearn.openLesson', [c.id], c.summary)),
        ...terms.map((t) => commandLink(t.term, 'codelearn.openMapItem', ['term', t.term], t.meaning)),
      ];
      if (found.length) md.appendMarkdown(`In this selection: ${found.join(' · ')}\n\n`);
    }

    const cached = await this.explainer.cached('line', target);
    if (cached) md.appendMarkdown(`**${escapeMd(cached.title)}**\n\n${clip(cached.body, 700)}\n\n`);

    const where = [doc.uri.toString(), sel.start.line, sel.start.character, sel.end.line, sel.end.character];
    md.appendMarkdown(
      [
        commandLink(
          cached ? '$(book) Open explanation' : '$(sparkle) Explain selection',
          'codelearn.explainRange',
          where,
          cached ? 'Saved earlier; no AI request' : 'Uses one AI request; the answer is saved',
        ),
        commandLink('$(debug-step-over) Step through', 'codelearn.stepThrough', [doc.uri.toString(), target.startLine + 1, target.endLine + 1], 'Walk through the selected code step by step'),
      ].join(' &nbsp;·&nbsp; '),
    );
  }

  private lookup(map: RepoMap, word: string): Concept[] {
    if (this.indexedMap !== map) {
      this.index = new ConceptIndex(map.concepts);
      this.indexedMap = map;
    }
    return this.index!.lookup(word);
  }
}

/** The selection the mouse is inside, if the learner has selected something in this document. */
function selectionAt(doc: vscode.TextDocument, pos: vscode.Position): vscode.Selection | undefined {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  return editor?.selections.find((s) => !s.isEmpty && s.contains(pos) && doc.getText(s).trim().length > 1);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n\n', max);
  return `${s.slice(0, cut > max / 2 ? cut : max)}…`;
}

function newMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: COMMANDS };
  return md;
}

function conceptHover(md: vscode.MarkdownString, c: Concept, status: 'new' | 'learning' | 'known', where: [string, number]): void {
  const badge = status === 'known' ? '$(check) You know this' : status === 'learning' ? '$(mortar-board) Learning' : '$(sparkle) New to you';
  md.appendMarkdown(`**${escapeMd(c.name)}** · ${c.kind} · ${badge}\n\n`);
  // Known concepts get the short version; the full lesson is always one click away.
  md.appendMarkdown(`${status === 'known' ? c.summary || c.hover : c.hover || c.summary}\n\n`);
  if (status !== 'known' && c.usage) md.appendMarkdown(`_In this repo:_ ${c.usage}\n\n`);
  if (c.citations.length && trustLevel(c.citations) !== 'checked') {
    md.appendMarkdown(`_$(warning) Not fully checked against the code._\n\n`);
  }
  const links = [
    commandLink('$(book) Open lesson', 'codelearn.openLesson', [c.id]),
    commandLink('$(debug-step-over) Step through', 'codelearn.stepThrough', where, 'Walk through the code around here step by step'),
    status === 'known'
      ? commandLink("I'm rusty on this", 'codelearn.setConceptStatus', [c.name, 'learning'])
      : commandLink('$(check) I know this', 'codelearn.setConceptStatus', [c.name, 'known']),
    commandLink('This is wrong', 'codelearn.reportWrong', [c.id]),
  ];
  md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
}

function termHover(md: vscode.MarkdownString, t: GlossaryTerm): void {
  md.appendMarkdown(`**${escapeMd(t.term)}** · business term\n\n${t.meaning}\n\n`);
  md.appendMarkdown(commandLink('More about this term', 'codelearn.openMapItem', ['term', t.term]));
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
