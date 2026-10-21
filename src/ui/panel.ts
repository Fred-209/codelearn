import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Zoom } from '../ai/prompts';
import { askPrompt } from '../ai/prompts';
import { Explainer, ExplainTarget } from '../learn/explain';
import { openAt, relPath } from '../learn/files';
import { Lessons } from '../learn/lessons';
import { reportError, Services } from '../services';
import type { Depth } from '../store/types';
import type { PanelHost, WalkState } from '../walkthrough/controller';
import { page, renderView, View } from './render';

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
    const names = await this.names();
    const base = { kind: 'lesson' as const, concept, depth: d, status, answers: [], names };

    const cached = await this.lessons.cached(concept, d);
    if (cached) return this.show({ ...base, lesson: cached });

    const view: View = { ...base, generating: `Writing a ${d === 'scratch' ? 'from-scratch' : d} lesson on ${concept.name}…` };
    this.show(view);
    await this.run(`writing the lesson on ${concept.name}`, async (token) => {
      const lesson = await this.lessons.generate(concept, d, token);
      if (this.view === view) this.show({ ...base, lesson });
    });
  }

  // ---- what's happening here ----

  async openExplain(target: ExplainTarget, zoom: Zoom, force = false): Promise<void> {
    this.explainTarget = target;
    const names = await this.names();
    const span = target.startLine === target.endLine ? `line ${target.startLine + 1}` : `lines ${target.startLine + 1}-${target.endLine + 1}`;
    const base = { kind: 'explain' as const, file: relPath(target.uri), lines: target.focus ? `your selection, ${span}` : span, zoom, names };
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
    const target: ExplainTarget = { uri, startLine: Math.max(0, line - 1), endLine: line - 1 };
    this.explainTarget = target;
    const base = { kind: 'explain' as const, file: relPath(uri), lines: `line ${line}`, zoom: 'line' as const, names: await this.names() };
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

  async openMapItem(type: 'overview' | 'area' | 'flow' | 'term' | 'convention', id: string): Promise<void> {
    const map = await this.s.store.getMap();
    if (!map) {
      vscode.window.showInformationMessage('codelearn: build the map first.', 'Build map').then((c) => {
        if (c) vscode.commands.executeCommand('codelearn.buildMap');
      });
      return;
    }
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
    this.show({ kind: 'usage', report });
  }

  showLoading(title: string, message: string): void {
    this.show({ kind: 'loading', title, message });
  }

  showError(title: string, message: string): void {
    this.show({ kind: 'error', title, message });
  }

  // ---- plumbing ----

  private show(view: View): void {
    this.view = view;
    const panel = this.ensurePanel();
    panel.title = titleFor(view);
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = page(renderView(view), nonce, panel.webview.cspSource);
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
    this.panel.onDidDispose(() => {
      const wasWalk = this.view?.kind === 'walkthrough';
      this.panel = undefined;
      this.view = undefined;
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

  private async onMessage(m: Record<string, string>): Promise<void> {
    const v = this.view;
    switch (m.action) {
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
      case 'wrong':
        return this.reportWrong();
      case 'ask':
        return this.ask();
      case 'map':
        return this.openMapItem(m.type as 'area', m.id);
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
