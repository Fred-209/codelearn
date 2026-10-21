import * as vscode from 'vscode';
import { openAt } from '../learn/files';
import type { Services } from '../services';
import type { Walkthrough } from '../store/types';
import { InlineCards } from './inline';

export interface WalkState {
  walkthrough: Walkthrough;
  index: number;
  view: 'inline' | 'panel';
}

/** Something that can show the walkthrough in the side panel. */
export interface PanelHost {
  showWalkthrough(state: WalkState): void;
  closeWalkthrough(): void;
}

/**
 * One walkthrough at a time. Inline cards and the side panel are two views of the
 * same state, so switching keeps your place.
 */
export class WalkthroughController implements vscode.Disposable {
  private state: WalkState | undefined;
  private readonly inline: InlineCards;
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderColor: new vscode.ThemeColor('focusBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  constructor(
    private readonly s: Services,
    private readonly panel: () => PanelHost,
  ) {
    this.inline = new InlineCards();
  }

  get current(): WalkState | undefined {
    return this.state;
  }

  async start(walkthrough: Walkthrough): Promise<void> {
    this.state = { walkthrough, index: 0, view: this.s.store.getWalkthroughView() };
    await vscode.commands.executeCommand('setContext', 'codelearn.walkthroughActive', true);
    await this.render();
  }

  next(): Promise<void> {
    return this.goto((this.state?.index ?? 0) + 1);
  }

  back(): Promise<void> {
    return this.goto((this.state?.index ?? 0) - 1);
  }

  async goto(index: number): Promise<void> {
    if (!this.state) return;
    const last = this.state.walkthrough.steps.length - 1;
    if (index > last) {
      const finished = this.state.walkthrough;
      vscode.window.showInformationMessage(`Walkthrough finished: ${finished.title}.`, 'Restart').then((c) => {
        if (c === 'Restart') void this.start(finished);
      });
      return this.end();
    }
    this.state.index = Math.max(0, index);
    await this.render();
  }

  /** `remember` = make this the view future walkthroughs start in. */
  async setView(view: 'inline' | 'panel', remember = true): Promise<void> {
    if (remember) await this.s.store.setWalkthroughView(view);
    if (!this.state) return;
    this.state.view = view;
    await this.render();
  }

  async end(): Promise<void> {
    this.state = undefined;
    this.inline.clear();
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.highlight, []);
    this.panel().closeWalkthrough();
    await vscode.commands.executeCommand('setContext', 'codelearn.walkthroughActive', false);
  }

  private async render(): Promise<void> {
    const st = this.state;
    const root = this.s.store.root;
    if (!st || !root) return;
    const step = st.walkthrough.steps[st.index];
    const editor = await openAt(root, step.file, step.line, vscode.ViewColumn.One);
    if (!editor || this.state !== st) return;

    const start = Math.max(0, step.line - 1);
    const end = Math.max(start, Math.min((step.endLine ?? step.line) - 1, editor.document.lineCount - 1));
    const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
    for (const e of vscode.window.visibleTextEditors) if (e !== editor) e.setDecorations(this.highlight, []);
    editor.setDecorations(this.highlight, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    if (st.view === 'inline') {
      const map = await this.s.store.getMap();
      const names = new Map((map?.concepts ?? []).map((c) => [c.id, c.name]));
      this.inline.show(editor.document.uri, range, st, names);
      this.panel().closeWalkthrough();
    } else {
      this.inline.clear();
      this.panel().showWalkthrough(st);
    }
  }

  dispose(): void {
    this.inline.dispose();
    this.highlight.dispose();
  }
}
