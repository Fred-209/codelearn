import * as vscode from 'vscode';
import { SLOT_LABELS, SLOTS, pickModel } from './ai/modelPick';
import { VsCodeLmProvider } from './ai/vscodeLm';
import { Explainer, ExplainTarget } from './learn/explain';
import { relPath } from './learn/files';
import { TeachingHover } from './learn/hover';
import { Lessons } from './learn/lessons';
import { offerInterviewOnce, runInterview } from './profile/interview';
import { Scanner } from './scan/scanner';
import { reportError, Services } from './services';
import { Store } from './store/store';
import type { ConceptStatus, Walkthrough } from './store/types';
import { MapTree } from './ui/mapTree';
import { LearnPanel } from './ui/panel';
import { WalkthroughController } from './walkthrough/controller';
import { WalkthroughBuilder } from './walkthrough/generate';

/** Returned from activate() so the integration tests can reach in. Not a public API. */
export interface CodelearnTestApi {
  services: Services;
  panel: LearnPanel;
  walks: WalkthroughController;
}

export function activate(context: vscode.ExtensionContext): CodelearnTestApi {
  const log = vscode.window.createOutputChannel('codelearn', { log: true });
  const store = new Store(context, vscode.workspace.workspaceFolders?.[0]);
  const services: Services = { context, store, ai: new VsCodeLmProvider(), log };

  const lessons = new Lessons(services);
  const explainer = new Explainer(services);
  const scanner = new Scanner(services);
  const builder = new WalkthroughBuilder(services);

  // The panel and the walkthrough controller refer to each other; the panel is created first.
  let walks: WalkthroughController;
  const startWalk = async (what: string, make: (token: vscode.CancellationToken) => Promise<Walkthrough>) => {
    try {
      const w = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `codelearn: preparing a walkthrough of ${what}…`, cancellable: true },
        (_p, token) => make(token),
      );
      await walks.start(w);
    } catch (e) {
      reportError(services, 'Could not prepare the walkthrough', e);
    }
  };
  const walkRange = (t: ExplainTarget) => startWalk(relPath(t.uri), (token) => builder.forRange(t.uri, t.startLine, t.endLine, token));
  const walkFlow = async (flowId: string) => {
    const flow = (await store.getMap())?.flows.find((f) => f.id === flowId);
    if (flow) await startWalk(`"${flow.name}"`, (token) => builder.forFlow(flow, token));
  };

  const panel = new LearnPanel(services, lessons, explainer, {
    walk: (op, index) => {
      if (op === 'next') void walks.next();
      else if (op === 'back') void walks.back();
      else if (op === 'end') void walks.end();
      else if (op === 'inline') void walks.setView('inline');
      else if (op === 'panelClosed') void walks.setView('inline', false);
      else if (op === 'goto' && index !== undefined) void walks.goto(index);
    },
    walkFlow: (id) => void walkFlow(id),
    walkRange: (t) => void walkRange(t),
  });
  walks = new WalkthroughController(services, () => panel);

  const tree = new MapTree(store);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = '$(book) codelearn';
  status.tooltip = "What's happening here? (Ctrl+Alt+/)";
  status.command = 'codelearn.whatsHappening';
  status.show();

  const editorTarget = async (): Promise<ExplainTarget | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('codelearn: put your cursor in a code file first.');
      return undefined;
    }
    return Explainer.targetFor(editor);
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        reportError(services, 'Something went wrong', e);
      }
    });

  context.subscriptions.push(
    log,
    panel,
    walks,
    status,
    vscode.window.registerTreeDataProvider('codelearn.map', tree),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new TeachingHover(services, explainer)),

    cmd('codelearn.buildMap', () => scanner.build('full')),
    cmd('codelearn.updateMap', () => scanner.build('update')),
    cmd('codelearn.setupProfile', () => runInterview(store)),
    cmd('codelearn.chooseModels', () => chooseModels(services)),

    cmd('codelearn.whatsHappening', async () => {
      const t = await editorTarget();
      if (t) await panel.openExplain(t, 'line');
    }),
    cmd('codelearn.explainSelection', async () => {
      const t = await editorTarget();
      if (t) await panel.openExplain(t, 'line');
    }),
    cmd('codelearn.explainWord', (word: string, uri: string, line: number) => panel.showQuick(word, vscode.Uri.parse(uri), line)),
    cmd('codelearn.stepThrough', async (uri?: string, line?: number) => {
      // From a hover we get the hovered location; from menus, the cursor.
      if (typeof uri === 'string' && typeof line === 'number') {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        return walkRange(await Explainer.targetAt(doc, new vscode.Position(line - 1, 0)));
      }
      const t = await editorTarget();
      if (t) await walkRange(t);
    }),
    cmd('codelearn.startFlowWalkthrough', (arg: unknown) => {
      // From the tree's inline button we get the tree node; from the panel, a flow id.
      const id = typeof arg === 'string' ? arg : ((arg as { item?: vscode.TreeItem })?.item?.id ?? '').replace(/^flow:/, '');
      return walkFlow(id);
    }),

    cmd('codelearn.openLesson', (ref: string) => panel.openLesson(ref)),
    cmd('codelearn.openMapItem', (type: 'overview' | 'area' | 'flow' | 'term' | 'convention', id: string) => panel.openMapItem(type, id)),
    cmd('codelearn.setConceptStatus', async (name: string, s: ConceptStatus) => {
      await store.setStatus(name, s);
      vscode.window.setStatusBarMessage(
        s === 'known' ? `codelearn: marked ${name} as known. Its full lesson is still one click away.` : `codelearn: ${name} is back on your learning list.`,
        4000,
      );
    }),
    cmd('codelearn.reportWrong', async (conceptId: string) => {
      const feedback = await vscode.window.showInputBox({
        title: "What's wrong with this description?",
        prompt: 'Optional, but it helps. codelearn will rewrite it with a stronger model.',
        ignoreFocusOut: true,
      });
      if (feedback === undefined) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'codelearn: rewriting the description…' }, () =>
        scanner.redescribe(conceptId, feedback || 'The learner says it is wrong but gave no details.'),
      );
      vscode.window.setStatusBarMessage('codelearn: description rewritten.', 4000);
    }),
    cmd('codelearn.searchConcept', () => searchConcept(store, panel)),
    cmd('codelearn.clearRepoData', async () => {
      const ok = await vscode.window.showWarningMessage(
        `Delete codelearn's saved map, lessons and walkthroughs for ${store.repoName}? Your profile and what you've marked as known are kept.`,
        { modal: true },
        'Delete',
      );
      if (ok === 'Delete') await store.clearRepo();
    }),

    cmd('codelearn.walkthrough.next', () => walks.next()),
    cmd('codelearn.walkthrough.back', () => walks.back()),
    cmd('codelearn.walkthrough.end', () => walks.end()),
    cmd('codelearn.walkthrough.openInPanel', () => walks.setView('panel')),
    cmd('codelearn.walkthrough.backToInline', () => walks.setView('inline')),

    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const map = await store.getMap();
      const file = relPath(doc.uri);
      if (map && file in map.fileHashes) tree.noteChanged(file);
    }),
  );

  void store.getMap().then((map) => {
    void vscode.commands.executeCommand('setContext', 'codelearn.hasMap', !!map);
  });
  store.onDidChange(() => void store.getMap().then((m) => vscode.commands.executeCommand('setContext', 'codelearn.hasMap', !!m)));
  if (context.extensionMode !== vscode.ExtensionMode.Test) void offerInterviewOnce(context, store);
  return { services, panel, walks };
}

export function deactivate(): void {}

async function chooseModels(s: Services): Promise<void> {
  const models = await s.ai.listModels();
  if (models.length === 0) {
    vscode.window.showErrorMessage('codelearn: no AI models are available. Install GitHub Copilot Chat and sign in.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('codelearn');
  for (const slot of SLOTS) {
    const current = cfg.get<string>(`models.${slot}`, 'auto');
    const auto = pickModel(models, slot, 'auto');
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Automatic', description: auto ? `currently ${auto.name}` : '', value: 'auto', picked: current === 'auto' },
        ...models.map((m) => ({ label: m.name, description: `${m.vendor} · ${m.family}`, value: m.id, picked: current === m.id })),
      ],
      { title: `codelearn model: ${SLOT_LABELS[slot]}`, placeHolder: `Now: ${current === 'auto' ? 'Automatic' : current}` },
    );
    if (!pick) return;
    await cfg.update(`models.${slot}`, pick.value, vscode.ConfigurationTarget.Global);
  }
  vscode.window.showInformationMessage('codelearn: model choices saved.');
}

async function searchConcept(store: Store, panel: LearnPanel): Promise<void> {
  const map = await store.getMap();
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { run?: () => void }>();
  qp.title = 'codelearn: find a concept';
  qp.placeholder = 'Type any concept, library, pattern or business term';
  qp.matchOnDescription = true;
  const base: (vscode.QuickPickItem & { run?: () => void })[] = [
    ...(map?.concepts ?? []).map((c) => ({
      label: c.name,
      description: c.kind,
      detail: c.summary,
      run: () => void panel.openLesson(c.id),
    })),
    ...(map?.glossary ?? []).map((g) => ({
      label: g.term,
      description: 'business term',
      detail: g.meaning,
      run: () => void panel.openMapItem('term', g.term),
    })),
  ];
  const refresh = () => {
    const typed = qp.value.trim();
    const exact = base.some((b) => b.label.toLowerCase() === typed.toLowerCase());
    qp.items = typed && !exact
      ? [...base, { label: `$(book) Explain “${typed}”`, description: 'write a lesson on anything', alwaysShow: true, run: () => void panel.openLesson(typed) }]
      : base;
  };
  refresh();
  qp.onDidChangeValue(refresh);
  qp.onDidAccept(() => {
    qp.selectedItems[0]?.run?.();
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
