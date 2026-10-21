// Runs inside a real VS Code (see ../runTest.ts). No real AI model is available here,
// so these tests seed the saved map, lessons and walkthroughs and check what the
// learner sees.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CodelearnTestApi } from '../../../src/extension';
import type { Lesson, RepoMap, Walkthrough } from '../../../src/store/types';
import { MAP_VERSION } from '../../../src/store/types';

const HANDLER = 'src/GetActivePaymentsHandler.cs';

const map: RepoMap = {
  version: MAP_VERSION,
  repoName: 'sample-repo',
  generatedAt: '2026-10-21T00:00:00Z',
  model: 'test',
  overview: 'A tiny payments sample.',
  areas: [{ id: 'handlers', name: 'Handlers', summary: 'Request handlers', paths: ['src'] }],
  flows: [{ id: 'get-active', name: 'Getting active payments', summary: 'Loads and filters payments.', files: [HANDLER] }],
  concepts: [
    {
      id: 'linq',
      name: 'LINQ',
      kind: 'library',
      summary: 'Query methods for collections.',
      hover: 'LINQ filters and transforms collections, like Array.filter and map.',
      match: ['Where', 'Select', 'ToList'],
      prereqs: ['Lambdas'],
      usage: 'Handlers filter repository results.',
      citations: [{ file: HANDLER, line: 15, quote: '.Where(p => p.Amount > 0)', verified: true }],
      docsSite: 'learn.microsoft.com',
      searchQuery: 'C# LINQ',
    },
  ],
  glossary: [{ term: 'Settlement batch', meaning: 'A group of payments settled together.', citations: [] }],
  conventions: [{ rule: 'Handlers filter after loading', source: 'AGENTS.md', status: 'confirmed', evidence: [] }],
  fileHashes: {},
};

const lesson: Lesson = {
  conceptId: 'linq',
  conceptName: 'C# LINQ',
  depth: 'standard',
  body: '### What it is\n\nLINQ adds query methods.',
  comparisons: [],
  usage: '',
  citations: [],
  pitfalls: [],
  generatedAt: '2026-10-21T00:00:00Z',
  model: 'test',
  sourceHash: '',
};

const walkthrough: Walkthrough = {
  id: 'test-walk',
  title: 'LINQ in Handle',
  summary: 'Filtering payments.',
  generatedAt: '2026-10-21T00:00:00Z',
  model: 'test',
  steps: [
    { file: HANDLER, line: 12, title: 'Load', body: 'Loads payments.', concepts: [], verified: true },
    { file: HANDLER, line: 15, title: 'Filter', body: 'Keeps positive amounts.', concepts: ['linq'], verified: true },
    { file: HANDLER, line: 17, title: 'Run', body: 'Runs the query.', concepts: [], verified: true },
  ],
};

let api: CodelearnTestApi;
let doc: vscode.TextDocument;

function root(): vscode.Uri {
  return vscode.workspace.workspaceFolders![0].uri;
}

async function hoverText(word: string, occurrence = 0): Promise<string> {
  const text = doc.getText();
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(word, index + 1);
  assert.ok(index >= 0, `${word} not found in fixture`);
  const pos = doc.positionAt(index + 1);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
    .join('\n');
}

function tabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('codelearn in VS Code', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension<CodelearnTestApi>('fred-209.codelearn');
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
    await api.services.store.saveMap(map);
    doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), HANDLER));
    await vscode.window.showTextDocument(doc);
  });

  it('registers every command it contributes', async () => {
    const pkg = vscode.extensions.getExtension('fred-209.codelearn')!.packageJSON as { contributes: { commands: { command: string }[] } };
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of pkg.contributes.commands) assert.ok(registered.has(command), `${command} is not registered`);
  });

  it('shows a teaching hover for a mapped concept, with lesson and step-through links', async () => {
    const text = await hoverText('Where');
    assert.match(text, /LINQ/);
    assert.match(text, /like Array\.filter/);
    assert.match(text, /Open lesson/);
    assert.match(text, /Step through/);
    assert.match(text, /I know this/);
  });

  it('shows business terms found inside identifiers', async () => {
    const text = await hoverText('settlementBatch');
    assert.match(text, /Settlement batch/);
    assert.match(text, /settled together/);
  });

  it('offers an explain link for things the map does not know, without calling the AI', async () => {
    const text = await hoverText('GetByAccountAsync');
    assert.match(text, /codelearn: explain/);
  });

  it('does not offer to explain plain words or words in comments', async () => {
    assert.doesNotMatch(await hoverText('the ids'), /codelearn/);
    assert.doesNotMatch(await hoverText('payments for'), /codelearn/);
  });

  it('explains the whole selection when hovering inside it', async () => {
    const editor = vscode.window.activeTextEditor!;
    const start = doc.getText().indexOf('.Where(');
    const end = doc.getText().indexOf('.ToList()') + '.ToList()'.length;
    editor.selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(end));
    try {
      const text = await hoverText('Select');
      assert.match(text, /Your selection/);
      assert.match(text, /lines 15–17/);
      assert.match(text, /In this selection: \[LINQ\]/);
      assert.match(text, /Explain selection/);
      assert.match(text, /Step through/);
    } finally {
      editor.selection = new vscode.Selection(0, 0, 0, 0);
    }
  });

  it('shortens the hover once a concept is marked known, and keeps the lesson link', async () => {
    await vscode.commands.executeCommand('codelearn.setConceptStatus', 'LINQ', 'known');
    assert.strictEqual(api.services.store.getStatus('LINQ'), 'known');
    const text = await hoverText('Where');
    assert.match(text, /You know this/);
    assert.match(text, /Open lesson/);
    assert.match(text, /rusty/);
    await vscode.commands.executeCommand('codelearn.setConceptStatus', 'LINQ', 'new');
  });

  it('opens a saved lesson in a tab beside the code', async () => {
    await api.services.store.saveLesson(lesson, true);
    await vscode.commands.executeCommand('codelearn.openLesson', 'linq');
    await until(() => tabLabels().includes('Lesson: LINQ'), 'lesson tab');
  });

  it('walks through steps inline, switches to the panel and back, keeping its place', async () => {
    await api.walks.start(walkthrough);
    const view = api.services.store.getWalkthroughView();
    assert.strictEqual(api.walks.current?.index, 0);
    assert.strictEqual(api.walks.current?.view, view);

    await vscode.commands.executeCommand('codelearn.walkthrough.next');
    assert.strictEqual(api.walks.current?.index, 1);
    assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 14);

    await vscode.commands.executeCommand('codelearn.walkthrough.openInPanel');
    assert.strictEqual(api.walks.current?.view, 'panel');
    assert.strictEqual(api.walks.current?.index, 1);
    await until(() => tabLabels().includes('Walkthrough: LINQ in Handle'), 'walkthrough tab');
    assert.strictEqual(api.services.store.getWalkthroughView(), 'panel', 'the panel choice should be remembered');

    await vscode.commands.executeCommand('codelearn.walkthrough.backToInline');
    assert.strictEqual(api.walks.current?.view, 'inline');
    assert.strictEqual(api.walks.current?.index, 1);

    await vscode.commands.executeCommand('codelearn.walkthrough.back');
    assert.strictEqual(api.walks.current?.index, 0);

    await vscode.commands.executeCommand('codelearn.walkthrough.end');
    assert.strictEqual(api.walks.current, undefined);
  });

  it('notices files that changed since the map was built, without the AI', async () => {
    // The seeded map has no file hashes, so every file in the fixture counts as changed.
    await api.checkFreshness();
    assert.ok(api.tree.changedCount > 0, 'expected changed files');
    const roots = await api.tree.getChildren();
    const first = api.tree.getTreeItem(roots[0]);
    assert.match(String(first.label), /changed: update the map/);
    assert.strictEqual(first.command?.command, 'codelearn.updateMap');
  });

  it('opens map items such as flows in the panel', async () => {
    await vscode.commands.executeCommand('codelearn.openMapItem', 'flow', 'get-active');
    await until(() => tabLabels().includes('codelearn map'), 'map tab');
  });

  it('goes back to the previous page in the tab', async () => {
    await api.panel.openLesson('linq');
    await until(() => tabLabels().includes('Lesson: LINQ'), 'lesson tab');
    await api.panel.openMapItem('flow', 'get-active');
    await until(() => tabLabels().includes('codelearn map'), 'map tab');
    assert.ok(api.panel.canGoBack);
    await api.panel.back();
    await until(() => tabLabels().includes('Lesson: LINQ'), 'back to the lesson');
  });

  it('sends requests to the Claude Code command line when chosen', async function () {
    if (process.platform === 'win32') this.skip();
    // A stand-in for `claude`: reports how much it read on stdin and which model it was asked for.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codelearn-claude-'));
    const fake = path.join(dir, 'claude');
    await fs.promises.writeFile(
      fake,
      [
        '#!/bin/sh',
        'input=$(cat)',
        'model=""',
        'while [ $# -gt 0 ]; do [ "$1" = "--model" ] && model="$2"; shift; done',
        'if [ "$model" = "opus" ]; then echo \'{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}\'; exit 1; fi',
        'printf \'{"type":"result","subtype":"success","is_error":false,"result":"got %s chars for %s","modelUsage":{"fake-%s":{"outputTokens":1}}}\\n\' "${#input}" "$model" "$model"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const cfg = vscode.workspace.getConfiguration('codelearn');
    await cfg.update('provider', 'claude-code', vscode.ConfigurationTarget.Global);
    await cfg.update('claudeCode.path', fake, vscode.ConfigurationTarget.Global);
    try {
      assert.strictEqual(await api.services.ai.name(), 'Claude Code');
      assert.strictEqual((await api.services.ai.modelFor('deep'))?.id, 'opus');

      const reply = await api.services.ai.complete({ slot: 'fast', system: 'S', user: 'U', justification: '', purpose: 'test' });
      assert.strictEqual(reply.text, `got ${'S\n\n---\n\nU'.length} chars for haiku`);
      assert.strictEqual(reply.model, 'fake-haiku');

      // The request is in the usage tally.
      await vscode.commands.executeCommand('codelearn.showUsage');
      await until(() => tabLabels().includes('codelearn: AI usage'), 'usage tab');

      await assert.rejects(
        () => api.services.ai.complete({ slot: 'deep', system: 'S', user: 'U', justification: '', purpose: 'test' }),
        // The bundled extension has its own copy of AIUnavailableError, so check the message.
        (e: Error) => /not signed in/.test(e.message),
      );
    } finally {
      await cfg.update('provider', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('claudeCode.path', undefined, vscode.ConfigurationTarget.Global);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
