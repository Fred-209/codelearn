import * as vscode from 'vscode';
import { EFFORTS, pickModel, RECOMMENDED_EFFORT, SLOT_LABELS, SLOTS } from './ai/modelPick';
import { NO_PROVIDER_HELP, PROVIDER_NAMES } from './ai/providerChoice';
import { ProviderRouter } from './ai/router';
import { Explainer, ExplainTarget } from './learn/explain';
import { relPath } from './learn/files';
import { TeachingHover } from './learn/hover';
import { Lessons } from './learn/lessons';
import { offerInterviewOnce, runInterview } from './profile/interview';
import { collectFiles } from './scan/collect';
import { changedFiles } from './scan/digest';
import { Scanner } from './scan/scanner';
import { reportError, Services } from './services';
import { Store } from './store/store';
import { UsageLog } from './store/usage';
import { usageReport } from './store/usageReport';
import type { ConceptStatus, RepoMap, Walkthrough } from './store/types';
import { MapTree } from './ui/mapTree';
import { LearnPanel } from './ui/panel';
import { WalkthroughController } from './walkthrough/controller';
import { WalkthroughBuilder } from './walkthrough/generate';

/** Returned from activate() so the integration tests can reach in. Not a public API. */
export interface CodelearnTestApi {
  services: Services;
  panel: LearnPanel;
  walks: WalkthroughController;
  tree: MapTree;
  checkFreshness: () => Promise<void>;
}

export function activate(context: vscode.ExtensionContext): CodelearnTestApi {
  const log = vscode.window.createOutputChannel('codelearn', { log: true });
  const store = new Store(context, vscode.workspace.workspaceFolders?.[0]);
  const usage = new UsageLog(context.globalStorageUri);
  const ai = new ProviderRouter(context, (entry) => void usage.record({ ...entry, repo: store.repoName }));
  const services: Services = { context, store, ai, log };

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
  status.command = 'codelearn.whatsHappening';
  const updateStatus = async () => {
    const since = new Date().setHours(0, 0, 0, 0);
    const today = (await usage.all()).filter((e) => Date.parse(e.at) >= since).length;
    const tip = new vscode.MarkdownString(
      `What's happening here? (Ctrl+Alt+/)\n\nAI requests today: ${today} · [Show AI usage](command:codelearn.showUsage)`,
    );
    tip.isTrusted = { enabledCommands: ['codelearn.showUsage'] };
    status.tooltip = tip;
  };
  void updateStatus();
  usage.onDidChange(() => void updateStatus());
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
    usage,
    panel,
    walks,
    status,
    vscode.window.registerTreeDataProvider('codelearn.map', tree),
    vscode.window.onDidChangeVisibleTextEditors(() => panel.applyHighlight()),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new TeachingHover(services, explainer)),

    cmd('codelearn.buildMap', () => scanner.build('full')),
    cmd('codelearn.updateMap', () => scanner.build('update')),
    cmd('codelearn.setupProfile', () => runInterview(store)),
    cmd('codelearn.chooseModels', () => chooseModels(ai)),
    cmd('codelearn.showUsage', async () => panel.showUsage(usageReport(await usage.all(), new Date()))),

    cmd('codelearn.whatsHappening', async () => {
      const t = await editorTarget();
      if (t) await panel.openExplain(t, 'line');
    }),
    cmd('codelearn.explainSelection', async () => {
      const t = await editorTarget();
      if (t) await panel.openExplain(t, 'line');
    }),
    cmd('codelearn.explainWord', (word: string, uri: string, line: number) => panel.showQuick(word, vscode.Uri.parse(uri), line)),
    cmd('codelearn.explainRange', async (uri: string, startLine: number, startChar: number, endLine: number, endChar: number) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await panel.openExplain(Explainer.targetForRange(doc, new vscode.Range(startLine, startChar, endLine, endChar)), 'line');
    }),
    cmd('codelearn.stepThrough', async (uri?: string, line?: number, endLine?: number) => {
      // From a hover we get the hovered location (1-based lines); from menus, the cursor.
      if (typeof uri === 'string' && typeof line === 'number' && typeof endLine === 'number') {
        return walkRange({ uri: vscode.Uri.parse(uri), startLine: line - 1, endLine: endLine - 1 });
      }
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

  // Compare the files on disk with the map (no AI), so a branch switch, a pull or a worktree
  // shows up as "N files changed" in the sidebar. Rechecked when the map changes and when
  // the window regains focus, at most every few minutes.
  let lastCheck = 0;
  const checkFreshness = async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const map = await store.getMap();
    if (!folder || !map) return tree.setChanged(new Set());
    lastCheck = Date.now();
    const cts = new vscode.CancellationTokenSource();
    try {
      const { hashes } = await collectFiles(folder, cts.token);
      tree.setChanged(changedFiles(map.fileHashes, hashes));
    } catch (e) {
      log.warn(`Checking for changed files failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      cts.dispose();
    }
  };
  const freshnessTimer = setTimeout(() => void checkFreshness(), context.extensionMode === vscode.ExtensionMode.Test ? 0 : 4000);
  context.subscriptions.push(
    { dispose: () => clearTimeout(freshnessTimer) },
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused && Date.now() - lastCheck > 5 * 60_000) void checkFreshness();
    }),
  );

  void store.getMap().then((map) => {
    void vscode.commands.executeCommand('setContext', 'codelearn.hasMap', !!map);
  });
  let checkedMap: RepoMap | undefined;
  store.onDidChange(async () => {
    const m = await store.getMap();
    void vscode.commands.executeCommand('setContext', 'codelearn.hasMap', !!m);
    // Profile and status changes fire this too; only a new map needs a recheck.
    if (m !== checkedMap) {
      checkedMap = m;
      void checkFreshness();
    }
  });
  if (context.extensionMode !== vscode.ExtensionMode.Test) void offerInterviewOnce(context, store);
  return { services, panel, walks, tree, checkFreshness };
}

export function deactivate(): void {}

async function chooseModels(ai: ProviderRouter): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('codelearn');
  const setting = cfg.get<string>('provider', 'auto');
  const [now, hasCopilot, hasClaude] = await Promise.all([
    ai.current(),
    ai.copilot.listModels().then((m) => m.length > 0, () => false),
    ai.claude.available(),
  ]);
  const found = (yes: boolean) => (yes ? 'available' : 'not found');
  const provider = await vscode.window.showQuickPick(
    [
      { label: 'Automatic', description: now ? `currently ${PROVIDER_NAMES[now]}` : 'nothing found yet', detail: 'Copilot when VS Code offers its models, otherwise Claude Code.', value: 'auto', picked: setting === 'auto' },
      { label: PROVIDER_NAMES.copilot, description: found(hasCopilot), detail: 'Models from GitHub Copilot Chat. No API key.', value: 'copilot', picked: setting === 'copilot' },
      {
        label: PROVIDER_NAMES['claude-code'],
        description: found(hasClaude),
        detail: 'Your Claude login, through the Claude Code command line. No API key.',
        value: 'claude-code',
        picked: setting === 'claude-code',
      },
    ],
    { title: 'codelearn: which AI should it use?', placeHolder: `Now: ${setting === 'auto' ? 'Automatic' : PROVIDER_NAMES[setting as 'copilot']}` },
  );
  if (!provider) return;
  await cfg.update('provider', provider.value, vscode.ConfigurationTarget.Global);

  const models = await ai.listModels();
  if (models.length === 0) {
    vscode.window.showErrorMessage(`codelearn: ${NO_PROVIDER_HELP}`);
    return;
  }
  const onCopilot = (await ai.current()) === 'copilot';
  const recommended = SLOTS.map((slot) => {
    const model = pickModel(models, slot, 'auto');
    return `${slot[0].toUpperCase()}${slot.slice(1)}: ${model?.name ?? 'none'} (${RECOMMENDED_EFFORT[slot]})`;
  });
  const how = await vscode.window.showQuickPick(
    [
      { label: '$(star) Use the recommended models', detail: recommended.join(' · '), value: 'recommended' },
      { label: 'Choose a model for each job myself', detail: `Pick from the ${models.length} models available`, value: 'custom' },
    ],
    { title: 'codelearn: which models?' },
  );
  if (!how) return;
  if (how.value === 'recommended') {
    for (const slot of SLOTS) {
      await cfg.update(`models.${slot}`, 'auto', vscode.ConfigurationTarget.Global);
      await cfg.update(`effort.${slot}`, 'auto', vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage(`codelearn: using the recommended models. ${recommended.join(', ')}.`);
    return;
  }

  for (const slot of SLOTS) {
    const current = cfg.get<string>(`models.${slot}`, 'auto');
    const best = pickModel(models, slot, 'auto');
    const others = models.filter((m) => m !== best);
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(star) Recommended: ${best?.name ?? 'none'}`, description: 'kept up to date as new models appear', value: 'auto', picked: current === 'auto' },
        ...others.map((m) => ({ label: m.name, description: `${m.vendor} · ${m.family}`, value: m.id, picked: current === m.id })),
      ],
      { title: `codelearn model: ${SLOT_LABELS[slot]}`, placeHolder: `Now: ${current === 'auto' ? 'Recommended' : current}` },
    );
    if (!pick) return;
    await cfg.update(`models.${slot}`, pick.value, vscode.ConfigurationTarget.Global);

    const currentEffort = cfg.get<string>(`effort.${slot}`, 'auto');
    const effort = await vscode.window.showQuickPick(
      [
        { label: `$(star) Recommended: ${RECOMMENDED_EFFORT[slot]}`, value: 'auto' },
        // Copilot's models offer low, medium and high.
        ...EFFORTS.filter((e) => e !== RECOMMENDED_EFFORT[slot] && (!onCopilot || ['low', 'medium', 'high'].includes(e))).map((e) => ({
          label: e,
          value: e,
        })),
      ],
      { title: `codelearn effort: ${SLOT_LABELS[slot]}`, placeHolder: `How hard the model thinks. Now: ${currentEffort === 'auto' ? 'Recommended' : currentEffort}` },
    );
    if (!effort) return;
    await cfg.update(`effort.${slot}`, effort.value, vscode.ConfigurationTarget.Global);
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
