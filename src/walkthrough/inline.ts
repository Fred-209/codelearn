import * as vscode from 'vscode';
import type { WalkState } from './controller';
import { commandLink } from '../ui/links';

/**
 * Shows the current walkthrough step as a card right under the code, using the
 * Comments API: the closest thing VS Code has to a balloon anchored to a line.
 */
export class InlineCards implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('codelearn', 'codelearn');
  private thread: vscode.CommentThread | undefined;

  show(uri: vscode.Uri, range: vscode.Range, st: WalkState, names: Map<string, string>): void {
    this.clear();
    const step = st.walkthrough.steps[st.index];
    const total = st.walkthrough.steps.length;
    const last = st.index === total - 1;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: [
        'codelearn.walkthrough.next',
        'codelearn.walkthrough.back',
        'codelearn.walkthrough.end',
        'codelearn.walkthrough.openInPanel',
        'codelearn.openLesson',
      ],
    };
    md.appendMarkdown(`**${escape(step.title)}**\n\n${step.body}\n\n`);
    if (step.concepts.length) {
      md.appendMarkdown(
        `Concepts: ${step.concepts.map((c) => commandLink(names.get(c) ?? c, 'codelearn.openLesson', [c], `Open a lesson on ${names.get(c) ?? c}`)).join(' · ')}\n\n`,
      );
    }
    if (!step.verified) md.appendMarkdown(`_$(warning) This step's location is the AI's guess; the quoted code wasn't found exactly._\n\n`);
    const nav = [
      st.index > 0 ? commandLink('$(arrow-left) Back', 'codelearn.walkthrough.back') : undefined,
      commandLink(last ? 'Finish $(check)' : 'Next $(arrow-right)', 'codelearn.walkthrough.next'),
      commandLink('$(layout-sidebar-right) Open in panel', 'codelearn.walkthrough.openInPanel'),
      commandLink('$(close) End', 'codelearn.walkthrough.end'),
    ].filter(Boolean);
    md.appendMarkdown(nav.join(' &nbsp;·&nbsp; '));

    const comment: vscode.Comment = {
      body: md,
      mode: vscode.CommentMode.Preview,
      author: { name: `${st.walkthrough.title} · step ${st.index + 1} of ${total}` },
    };
    this.thread = this.controller.createCommentThread(uri, range, [comment]);
    this.thread.canReply = false;
    this.thread.label = 'codelearn walkthrough';
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  clear(): void {
    this.thread?.dispose();
    this.thread = undefined;
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
