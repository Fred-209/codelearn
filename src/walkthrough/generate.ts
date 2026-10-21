import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { list, obj, step, str } from '../ai/normalize';
import { walkthroughPrompt } from '../ai/prompts';
import { verifySteps } from '../learn/anchor';
import { numberedRange, readText, relPath } from '../learn/files';
import { numbered } from '../scan/digest';
import type { Services } from '../services';
import { hash } from '../store/store';
import type { Flow, Walkthrough } from '../store/types';

interface Source {
  file: string;
  code: string; // numbered
  lines: string[]; // raw lines of the whole file, for verifying steps
}

const MAX_SOURCE_CHARS = 60_000;

export class WalkthroughBuilder {
  constructor(private readonly s: Services) {}

  async forFlow(flow: Flow, token?: vscode.CancellationToken, force = false): Promise<Walkthrough> {
    const root = this.requireRoot();
    if (flow.steps?.length && !force) {
      const fromMap = await this.fromSteps(flow, root);
      if (fromMap) return fromMap;
    }
    const sources: Source[] = [];
    let total = 0;
    for (const file of flow.files.slice(0, 8)) {
      const text = await readText(root, file);
      if (!text) continue;
      const code = numbered(text, 300);
      if (total + code.length > MAX_SOURCE_CHARS && sources.length > 0) break;
      total += code.length;
      sources.push({ file, code, lines: text.split(/\r?\n/) });
    }
    if (sources.length === 0) throw new Error(`None of the files in "${flow.name}" could be read. Try "codelearn: Update map".`);
    return this.build(`flow-${flow.id}`, `walk through "${flow.name}". ${flow.summary}`, sources, 'deep', token, force);
  }

  /**
   * A flow the map followed step by step walks with no AI request, as long as most of its steps
   * still point at the code they quoted. Otherwise the code changed too much and the AI writes it.
   */
  private async fromSteps(flow: Flow, root: vscode.Uri): Promise<Walkthrough | undefined> {
    const steps = flow.steps ?? [];
    const sources: { file: string; lines: string[] }[] = [];
    for (const file of new Set(steps.map((st) => st.file))) {
      const text = await readText(root, file);
      if (text) sources.push({ file, lines: text.split(/\r?\n/) });
    }
    const checked = verifySteps(steps.map((st) => ({ ...st, concepts: st.concepts ?? [] })), sources);
    const found = checked.filter((st) => st.verified).length;
    if (checked.length < 2 || found < Math.ceil(steps.length / 2)) return undefined;
    return { id: `flow-${flow.id}`, title: flow.name, summary: flow.summary, steps: checked, generatedAt: new Date().toISOString(), model: 'the repo map' };
  }

  async forRange(uri: vscode.Uri, startLine: number, endLine: number, token?: vscode.CancellationToken): Promise<Walkthrough> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const code = numberedRange(doc, startLine, endLine);
    const sources: Source[] = [{ file: relPath(uri), code, lines: doc.getText().split(/\r?\n/) }];
    const goal = `step through what lines ${startLine + 1}-${endLine + 1} of ${relPath(uri)} do, piece by piece, in the order they run. Stay within those lines.`;
    return this.build(`range-${hash(relPath(uri) + code)}`, goal, sources, 'standard', token, false);
  }

  private async build(
    id: string,
    goal: string,
    sources: Source[],
    slot: 'deep' | 'standard',
    token: vscode.CancellationToken | undefined,
    force: boolean,
  ): Promise<Walkthrough> {
    const sourceHash = hash(sources.map((s) => s.lines.join('\n')).join('\u0000'));
    const cached = await this.s.store.getWalkthrough(id);
    if (cached && !force && cached.sourceHash === sourceHash) return cached;

    const map = await this.s.store.getMap();
    const { value, model } = await completeJson(
      this.s.ai,
      {
        slot,
        ...walkthroughPrompt(goal, sources.map((s) => ({ file: s.file, code: s.code })), map, this.s.store.getProfile()),
        justification: 'codelearn walks you through the code you are reading.',
        purpose: `walkthrough: ${goal}`,
      },
      (v) => {
        const o = obj(v);
        const steps = list(o.steps, step, 15);
        if (steps.length === 0) throw new Error('The AI reply had no walkthrough steps.');
        return { title: str(o.title) || 'Walkthrough', summary: str(o.summary), steps };
      },
      token,
    );
    const steps = verifySteps(value.steps, sources);
    if (steps.length === 0) throw new Error('None of the walkthrough steps pointed at real code. Try again.');
    const w: Walkthrough = { id, ...value, steps, generatedAt: new Date().toISOString(), model, sourceHash };
    await this.s.store.saveWalkthrough(w);
    return w;
  }

  private requireRoot(): vscode.Uri {
    const root = this.s.store.root;
    if (!root) throw new Error('Open a folder first.');
    return root;
  }
}
