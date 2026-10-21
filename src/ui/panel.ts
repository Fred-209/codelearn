import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Zoom } from '../ai/prompts';
import { askPrompt } from '../ai/prompts';
import type { ExampleSearch } from '../learn/examples';
import { Explainer, ExplainTarget } from '../learn/explain';
import { openAt, relPath } from '../learn/files';
import { Lessons } from '../learn/lessons';
import { placesFor } from '../learn/places';
import { reportError, Services } from '../services';
import type { Depth } from '../store/types';
import type { PanelHost, WalkState } from '../walkthrough/controller';
import { MapItemType, page, renderBackBar, renderCodebase, renderView, View } from './render';
import type { RepoMap } from '../store/types';

/** A page in the tab's history, and how to show it again. */
interface Page {
  key: string;
  title: string;
  open: () => unknown;
}

function mapItemTitle(map: RepoMap, type: MapItemType, id: string): string {
  switch (type) {
    case 'overview':
      return `${map.repoName} overview`;
    case 'architecture':
      return `${map.repoName} architecture`;
    case 'part':
      return map.architecture?.parts.find((p) => p.id === id)?.name ?? 'Part';
    case 'area':
      return map.areas.find((a) => a.id === id)?.name ?? 'Area';
    case 'flow':
      return map.flows.find((f) => f.id === id)?.name ?? 'Flow';
    case 'term':
      return id;
    default:
      return map.conventions[Number(id)]?.rule ?? 'Convention';
  }
}

export interface PanelActions {
  walk(op: 'next' | 'back' | 'end' | 'inline' | 'panelClosed' | 'goto', index?: number): void;
  walkFlow(flowId: string): void;
  walkRange(target: ExplainTarget): void;
}

/**
 * The codelearn tab beside the editor: lessons, "What's happening here?",
 * map details, and walkthroughs in panel mode.
 */
export class LearnPanel implements PanelHost, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private view: View | undefined;
  /** What to go back to when a walkthrough leaves the panel. */
  private beforeWalk: View | undefined;
  private explainTarget: ExplainTarget | undefined;
  private work: vscode.CancellationTokenSource | undefined;
  /** Pages visited in this tab, for Back. */
  private history: Page[] = [];
  private current: Page | undefined;
  private goingBack = false;
  /** Set when the page changed while the tab was hidden, so it is drawn again when shown. */
  private stale = false;
  /** The page on show, and whether its script has loaded; updates wait until it has. */
  private pageId = '';
  private loaded = false;
  private pending: { id: string; html: string }[] = [];

  constructor(
    private readonly s: Services,
    private readonly lessons: Lessons,
    private readonly explainer: Explainer,
    private readonly actions: PanelActions,
  ) {}

  // ---- lessons ----

  async openLesson(ref: string, depth?: Depth): Promise<void> {
    const concept = await this.lessons.resolve(ref);
    const status = this.s.store.getStatus(concept.name);
    const d: Depth = depth ?? (status === 'known' ? 'refresher' : this.s.store.getProfile()?.experience === 'new' ? 'scratch' : 'standard');
    this.visit({ key: `lesson:${concept.id}`, title: concept.name, open: () => this.openLesson(concept.id, d) });
    const names = await this.names();
    const base = { kind: 'lesson' as const, concept, depth: d, status, answers: [], names };

    const cached = await this.lessons.cached(concept, d);
    if (cached) return this.showLesson({ ...base, lesson: cached });

    const view: View = { ...base, generating: `Writing a ${d === 'scratch' ? 'from-scratch' : d} lesson on ${concept.name}…` };
    this.show(view);
    await this.run(`writing the lesson on ${concept.name}`, async (token) => {
      const lesson = await this.lessons.generate(concept, d, token);
      if (this.view === view) void this.showLesson({ ...base, lesson });
    });
  }

  /** Shows a lesson, then searches the repo for real uses of it (no AI) and adds them when found. */
  private async showLesson(view: Extract<View, { kind: 'lesson' }>): Promise<void> {
    this.show({ ...view, searching: true });
    let examples: ExampleSearch | undefined;
    try {
      examples = await this.lessons.examples(view.concept, view.lesson);
    } catch (e) {
      this.s.log.warn(`Looking for examples of ${view.concept.name} failed: ${e instanceof Error ? e.message : e}`);
    }
    const now = this.view;
    if (now?.kind !== 'lesson' || now.concept.id !== view.concept.id || now.lesson !== view.lesson) return;
    const next = { ...now, searching: false, examples };
    this.view = next;
    // Only that section changes, so the reader keeps their place.
    this.patch('codebase', renderCodebase(next));
  }

  /** Replaces one element of the page on show, once the page can take it. */
  private patch(id: string, html: string): void {
    if (!this.panel?.visible) {
      this.stale = true;
    } else if (this.loaded) {
      void this.panel.webview.postMessage({ type: 'replace', id, html });
    } else {
      this.pending.push({ id, html });
    }
  }

  // ---- what's happening here ----

  async openExplain(target: ExplainTarget, zoom: Zoom, force = false): Promise<void> {
    const where = `${relPath(target.uri)}:${target.startLine + 1}`;
    // Smaller and Larger replace the page rather than stacking, so key a ladder on its cursor line.
    const at = target.ladder ? `at:${target.ladder[0].start}` : `${target.startLine}-${target.endLine}:${target.focus ?? ''}`;
    this.visit({
      key: `explain:${target.uri.toString()}:${at}`,
      title: `What's happening in ${where}`,
      open: () => this.openExplain(target, zoom),
    });
    this.explainTarget = target;
    this.highlight(zoom === 'line' ? target : undefined);
    const names = await this.names();
    const span = target.startLine === target.endLine ? `line ${target.startLine + 1}` : `lines ${target.startLine + 1}-${target.endLine + 1}`;
    const lines = target.focus ? `your selection, ${span}` : target.label ? `${target.label} · ${span}` : span;
    const scope =
      zoom === 'line' && target.ladder && target.scope !== undefined
        ? { smaller: target.scope > 0, larger: target.scope < target.ladder.length - 1 }
        : undefined;
    const base = { kind: 'explain' as const, file: relPath(target.uri), lines, zoom, names, scope, places: await this.places(target.uri) };
    const cached = force ? undefined : await this.explainer.cached(zoom, target);
    if (cached) return this.show({ ...base, explanation: cached });

    const label = { line: 'this code', file: 'this file', flow: 'the flow this file is part of' }[zoom];
    const view: View = { ...base, generating: `Explaining ${label}…` };
    this.show(view);
    await this.run(`explaining ${label}`, async (token) => {
      const explanation = await this.explainer.explain(zoom, target, token);
      if (this.view === view) this.show({ ...base, explanation });
    });
  }

  async showQuick(word: string, uri: vscode.Uri, line: number): Promise<void> {
    this.visit({ key: `quick:${word}:${uri.toString()}`, title: word, open: () => this.showQuick(word, uri, line) });
    const target: ExplainTarget = { uri, startLine: Math.max(0, line - 1), endLine: line - 1 };
    this.explainTarget = target;
    this.highlight(undefined);
    const base = {
      kind: 'explain' as const,
      file: relPath(uri),
      lines: `line ${line}`,
      zoom: 'line' as const,
      names: await this.names(),
      places: await this.places(uri),
    };
    const cached = await this.explainer.getQuickCached(word, uri);
    if (cached) return this.show({ ...base, explanation: cached });
    const view: View = { ...base, generating: `Explaining ${word}…` };
    this.show(view);
    await this.run(`explaining ${word}`, async (token) => {
      const explanation = await this.explainer.quick(word, uri, line, token);
      if (this.view === view) this.show({ ...base, explanation });
    });
  }

  // ---- map items ----

  async openMapItem(type: MapItemType, id: string): Promise<void> {
    const map = await this.s.store.getMap();
    if (!map) {
      vscode.window.showInformationMessage('codelearn: build the map first.', 'Build map').then((c) => {
        if (c) vscode.commands.executeCommand('codelearn.buildMap');
      });
      return;
    }
    this.visit({ key: `map:${type}:${id}`, title: mapItemTitle(map, type, id), open: () => this.openMapItem(type, id) });
    this.show({ kind: 'mapItem', map, type, id });
  }

  // ---- walkthroughs (PanelHost) ----

  showWalkthrough(state: WalkState): void {
    if (this.view?.kind !== 'walkthrough') this.beforeWalk = this.view;
    void this.names().then((names) => this.show({ kind: 'walkthrough', walkthrough: state.walkthrough, index: state.index, names }));
  }

  closeWalkthrough(): void {
    if (this.view?.kind !== 'walkthrough') return;
    const back = this.beforeWalk;
    this.beforeWalk = undefined;
    if (back) {
      this.show(back);
    } else {
      this.view = undefined;
      this.panel?.dispose();
    }
  }

  showUsage(report: string): void {
    this.visit({ key: 'usage', title: 'AI usage', open: () => vscode.commands.executeCommand('codelearn.showUsage') });
    this.show({ kind: 'usage', report });
  }

  // ---- history ----

  /** Records a page the tab is about to show, so Back can return to the one before it. */
  private visit(page: Page): void {
    if (this.goingBack) {
      this.goingBack = false;
    } else if (this.current && this.current.key !== page.key) {
      this.history.push(this.current);
      if (this.history.length > 30) this.history.shift();
    }
    // Same page with a different depth or zoom replaces the entry instead of stacking.
    this.current = page;
  }

  /** Back to the previous page. Saved lessons reopen instantly, with no AI request. */
  async back(): Promise<void> {
    const previous = this.history.pop();
    if (!previous) return;
    this.goingBack = true;
    try {
      await previous.open();
    } finally {
      this.goingBack = false;
    }
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  showLoading(title: string, message: string): void {
    this.show({ kind: 'loading', title, message });
  }

  showError(title: string, message: string): void {
    this.show({ kind: 'error', title, message });
  }

  // ---- plumbing ----

  private show(view: View): void {
    if (view.kind !== 'explain') this.highlight(undefined);
    this.view = view;
    this.render(this.ensurePanel(), view);
  }

  private render(panel: vscode.WebviewPanel, view: View): void {
    this.stale = false;
    this.loaded = false;
    this.pending = [];
    panel.title = titleFor(view);
    const nonce = randomBytes(16).toString('base64');
    this.pageId = nonce;
    const previous = view.kind === 'walkthrough' ? undefined : this.history.at(-1);
    panel.webview.html = page(`${previous ? renderBackBar(previous.title) : ''}${renderView(view)}`, nonce, panel.webview.cspSource);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.panel;
    }
    this.panel = vscode.window.createWebviewPanel(
      'codelearn',
      'codelearn',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.s.context.extensionUri, 'media', 'codelearn.svg');
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => reportError(this.s, 'Something went wrong', e)));
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible && this.stale && this.view) this.render(e.webviewPanel, this.view);
    });
    this.panel.onDidDispose(() => {
      this.highlight(undefined);
      const wasWalk = this.view?.kind === 'walkthrough';
      this.panel = undefined;
      this.view = undefined;
      this.history = [];
      this.current = undefined;
      this.work?.cancel();
      if (wasWalk) this.actions.walk('panelClosed');
    });
    return this.panel;
  }

  private async run(what: string, fn: (token: vscode.CancellationToken) => Promise<void>): Promise<void> {
    this.work?.cancel();
    const cts = (this.work = new vscode.CancellationTokenSource());
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `codelearn: ${what}` }, () => fn(cts.token));
    } catch (e) {
      if (cts.token.isCancellationRequested) return;
      reportError(this.s, `Failed while ${what}`, e);
      this.showError('Something went wrong', e instanceof Error ? e.message : String(e));
    } finally {
      if (this.work === cts) this.work = undefined;
      cts.dispose();
    }
  }

  private async names(): Promise<Record<string, string>> {
    const map = await this.s.store.getMap();
    return Object.fromEntries((map?.concepts ?? []).map((c) => [c.id, c.name]));
  }

  /** The parts, areas and flows of the map that a file belongs to. */
  private async places(uri: vscode.Uri) {
    const map = await this.s.store.getMap();
    return map ? placesFor(map, relPath(uri)) : [];
  }

  private async onMessage(m: Record<string, string>): Promise<void> {
    const v = this.view;
    switch (m.action) {
      case 'loaded':
        if (m.page === this.pageId) {
          this.loaded = true;
          for (const p of this.pending.splice(0)) void this.panel?.webview.postMessage({ type: 'replace', ...p });
        }
        return;
      case 'back':
        return this.back();
      case 'lesson':
        return this.openLesson(m.ref);
      case 'depth':
        if (v?.kind === 'lesson') return this.openLesson(v.concept.id, m.depth as Depth);
        return;
      case 'status':
        if (v?.kind === 'lesson') {
          await this.s.store.setStatus(v.concept.name, m.status as 'known' | 'learning');
          this.show({ ...v, status: this.s.store.getStatus(v.concept.name) });
        }
        return;
      case 'open': {
        const root = this.s.store.root;
        if (root) await openAt(root, m.file, Number(m.line) || 1, vscode.ViewColumn.One);
        return;
      }
      case 'zoom':
        if (this.explainTarget) return this.openExplain(this.explainTarget, m.zoom as Zoom);
        return;
      case 'scope': {
        const t = this.explainTarget;
        if (!t?.ladder || t.scope === undefined) return;
        return this.openExplain(Explainer.atScope(t.uri, t.ladder, t.scope + (m.dir === 'larger' ? 1 : -1)), 'line');
      }
      case 'wrong':
        return this.reportWrong();
      case 'ask':
        return this.ask();
      case 'map':
        return this.openMapItem(m.type as MapItemType, m.id);
      case 'explore':
        await vscode.commands.executeCommand('codelearn.exploreArea', m.id);
        return;
      case 'investigate':
        await vscode.commands.executeCommand('codelearn.investigate');
        return;
      case 'build-map':
        await vscode.commands.executeCommand('codelearn.buildMap');
        return;
      case 'walk-flow':
        return this.actions.walkFlow(m.id);
      case 'walk-range':
        if (this.explainTarget) this.actions.walkRange(this.explainTarget);
        return;
      case 'walk-next':
        return this.actions.walk('next');
      case 'walk-back':
        return this.actions.walk('back');
      case 'walk-end':
        return this.actions.walk('end');
      case 'walk-inline':
        return this.actions.walk('inline');
      case 'walk-goto':
        return this.actions.walk('goto', Number(m.index));
    }
  }

  async reportWrong(): Promise<void> {
    const v = this.view;
    if (v?.kind === 'lesson') {
      const feedback = await vscode.window.showInputBox({
        title: `What's wrong with the lesson on ${v.concept.name}?`,
        prompt: 'Optional, but it helps. codelearn will rewrite the lesson with a stronger model.',
        ignoreFocusOut: true,
      });
      if (feedback === undefined) return;
      const view: View = { ...v, lesson: undefined, generating: 'Rewriting the lesson with your feedback…' };
      this.show(view);
      await this.run('rewriting the lesson', async (token) => {
        const lesson = await this.lessons.generate(v.concept, v.depth, token, feedback || 'The learner says it is wrong but gave no details.');
        if (this.view === view) this.show({ ...v, lesson });
      });
    } else if (v?.kind === 'explain' && this.explainTarget) {
      await this.openExplain(this.explainTarget, v.zoom, true);
    }
  }

  private async ask(): Promise<void> {
    const v = this.view;
    if (v?.kind !== 'lesson') return;
    const question = await vscode.window.showInputBox({ title: `Ask about ${v.concept.name}`, ignoreFocusOut: true });
    if (!question) return;
    const entry: { question: string; answer?: string } = { question };
    const answers = [...v.answers, entry];
    this.show({ ...v, answers });
    await this.run('answering your question', async (token) => {
      const context = [v.concept.usage, v.lesson?.body.slice(0, 3000)].filter(Boolean).join('\n\n');
      const res = await this.s.ai.complete(
        { slot: 'standard', ...askPrompt(question, v.concept.name, context, this.s.store.getProfile()), justification: 'codelearn answers your question.', purpose: `question: ${v.concept.name}` },
        token,
      );
      entry.answer = res.text;
      if (this.view?.kind === 'lesson' && this.view.concept.id === v.concept.id) this.show({ ...this.view, answers });
    });
  }

  dispose(): void {
    this.work?.cancel();
    this.panel?.dispose();
    this.marker.dispose();
  }

  /** Shades the lines being explained in any editor showing that file, so it's clear what was picked. */
  private readonly marker = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true,
  });
  private marked: ExplainTarget | undefined;

  private highlight(target: ExplainTarget | undefined): void {
    this.marked = target;
    this.applyHighlight();
  }

  applyHighlight(): void {
    const t = this.marked;
    for (const editor of vscode.window.visibleTextEditors) {
      const on = t && editor.document.uri.toString() === t.uri.toString();
      editor.setDecorations(this.marker, on ? [new vscode.Range(t.startLine, 0, t.endLine, 0)] : []);
    }
  }

  /** The lines currently shaded, for tests. */
  highlighted(): { uri: string; startLine: number; endLine: number } | undefined {
    return this.marked && { uri: this.marked.uri.toString(), startLine: this.marked.startLine, endLine: this.marked.endLine };
  }
}

function titleFor(v: View): string {
  switch (v.kind) {
    case 'lesson':
      return `Lesson: ${v.concept.name}`;
    case 'explain':
      return "What's happening here?";
    case 'walkthrough':
      return `Walkthrough: ${v.walkthrough.title}`;
    case 'mapItem':
      return 'codelearn map';
    case 'usage':
      return 'codelearn: AI usage';
    default:
      return 'codelearn';
  }
}
