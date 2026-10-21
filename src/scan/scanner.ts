import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { conceptDetails, ConceptDetail, mapSkeleton, MapSkeleton } from '../ai/normalize';
import { conceptDetailsPrompt, mapPrompt } from '../ai/prompts';
import { verifyAll, verifyCitation, FileLookup } from '../learn/anchor';
import { readText } from '../learn/files';
import { matchTokens } from '../learn/matcher';
import type { Services } from '../services';
import type { Concept, RepoMap } from '../store/types';
import { MAP_VERSION } from '../store/types';
import { addOutlines, collectFiles } from './collect';
import { buildDigest, changedFiles, estimateRequests, findOccurrences, RepoFile } from './digest';

const BATCH = 8;
const EXPECTED_CONCEPTS = 40;
const JUSTIFICATION = 'codelearn reads your code to explain it to you.';

/** Builds the repo map: one request for the big picture, then batches for concept hovers. */
export class Scanner {
  private running = false;

  constructor(private readonly s: Services) {}

  async build(mode: 'full' | 'update'): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('codelearn: open a folder first.');
      return;
    }
    if (this.running) {
      vscode.window.showInformationMessage('codelearn is already building the map.');
      return;
    }
    const [deep, standard] = await Promise.all([this.s.ai.modelFor('deep'), this.s.ai.modelFor('standard')]);
    if (!deep || !standard) {
      vscode.window.showErrorMessage(
        'codelearn: no AI model is available. It uses GitHub Copilot\'s models: install Copilot Chat and sign in, then try again.',
      );
      return;
    }

    this.running = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'codelearn', cancellable: true },
        async (progress, token) => {
          progress.report({ message: 'Reading files…' });
          const { files, hashes } = await collectFiles(folder, token);
          if (token.isCancellationRequested) return;
          if (files.length === 0) {
            vscode.window.showWarningMessage('codelearn: found no code files to read in this folder.');
            return;
          }
          const lookup = makeLookup(files);
          const previous = await this.s.store.getMap();

          if (mode === 'update' && previous) {
            await this.update(previous, files, hashes, lookup, standard.name, progress, token);
            return;
          }

          progress.report({ message: 'Reading symbols…' });
          await addOutlines(folder, files, token);
          const budget = Math.max(40_000, Math.min(deep.maxInputTokens * 2.4, 400_000));
          const digest = buildDigest(files, { repoName: folder.name, budget });

          const requests = estimateRequests(EXPECTED_CONCEPTS, BATCH);
          const ok = await vscode.window.showInformationMessage(
            `Build a map of ${folder.name}?`,
            {
              modal: true,
              detail:
                `codelearn read ${files.length} files. It will send a summary of the repo (about ${Math.round(digest.text.length / 1000)}k characters) ` +
                `to ${deep.name}, then describe each concept it finds with ${standard.name}: about ${requests} AI requests through your AI provider (GitHub Copilot).\n\n` +
                'Lessons are written later, only when you open one. Results are saved on this computer only.',
            },
            'Build map',
          );
          if (ok !== 'Build map' || token.isCancellationRequested) return;

          progress.report({ message: `Mapping the repo with ${deep.name}… (this can take a minute)` });
          const { value: skeleton, model } = await completeJson(
            this.s.ai,
            { slot: 'deep', ...mapPrompt(digest.text, this.s.store.getProfile()), justification: JUSTIFICATION },
            mapSkeleton,
            token,
          );
          verifySkeleton(skeleton, lookup);

          const details = await this.describeConcepts(skeleton.concepts, files, skeleton.overview, previous, hashes, progress, token);
          const map: RepoMap = {
            version: MAP_VERSION,
            repoName: folder.name,
            generatedAt: new Date().toISOString(),
            model,
            ...skeleton,
            concepts: applyDetails(skeleton.concepts, details, lookup),
            fileHashes: hashes,
          };
          await this.s.store.saveMap(map);
          this.s.log.info(`Map built: ${map.concepts.length} concepts, ${map.flows.length} flows, ${map.glossary.length} terms.`);
          vscode.window.showInformationMessage(
            `codelearn mapped ${folder.name}: ${map.areas.length} areas, ${map.flows.length} flows, ${map.concepts.length} concepts. Hover over code to start, or open the codelearn sidebar.`,
          );
        },
      );
    } finally {
      this.running = false;
    }
  }

  /** Re-describes only concepts touched by changed files and re-checks every citation. */
  private async update(
    previous: RepoMap,
    files: RepoFile[],
    hashes: Record<string, string>,
    lookup: FileLookup,
    standardName: string,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const changed = changedFiles(previous.fileHashes, hashes);
    if (changed.size === 0) {
      vscode.window.showInformationMessage('codelearn: nothing has changed since the map was built.');
      return;
    }
    if (changed.size > Math.max(20, Object.keys(hashes).length * 0.3)) {
      const choice = await vscode.window.showInformationMessage(
        `${changed.size} files changed since the map was built. Rebuilding the whole map will be more accurate.`,
        'Rebuild map',
        'Update anyway',
      );
      if (choice === 'Rebuild map') {
        this.running = false;
        return this.build('full');
      }
      if (choice !== 'Update anyway') return;
    }

    const changedText = files.filter((f) => changed.has(f.path));
    const touched = previous.concepts.filter(
      (c) =>
        c.citations.some((ct) => changed.has(ct.file)) ||
        findOccurrences(changedText, c.match.flatMap(matchTokens), 1).length > 0,
    );
    const requests = Math.ceil(touched.length / BATCH);
    if (requests > 0) {
      const ok = await vscode.window.showInformationMessage(
        `${changed.size} files changed. Update ${touched.length} concepts with ${standardName} (about ${requests} AI requests)?`,
        'Update',
      );
      if (ok !== 'Update') return;
    }

    const details = await this.describeConcepts(touched, files, previous.overview, undefined, hashes, progress, token);
    const skeleton: MapSkeleton = {
      overview: previous.overview,
      areas: previous.areas,
      flows: previous.flows,
      concepts: previous.concepts,
      glossary: previous.glossary,
      conventions: previous.conventions,
    };
    verifySkeleton(skeleton, lookup);
    const map: RepoMap = {
      ...previous,
      ...skeleton,
      concepts: applyDetails(previous.concepts, details, lookup),
      fileHashes: hashes,
      generatedAt: new Date().toISOString(),
    };
    await this.s.store.saveMap(map);
    vscode.window.showInformationMessage(
      `codelearn updated ${touched.length} concepts from ${changed.size} changed files. New concepts are only found by "Build map".`,
    );
  }

  /** Rewrites one concept's hover after the learner says it's wrong, using the Deep model. */
  async redescribe(conceptId: string, feedback: string, token?: vscode.CancellationToken): Promise<void> {
    const map = await this.s.store.getMap();
    const root = this.s.store.root;
    const concept = map?.concepts.find((c) => c.id === conceptId);
    if (!map || !root || !concept) return;

    // Occurrences come from the files the concept already cites, re-read from disk.
    const files: RepoFile[] = [];
    for (const file of new Set(concept.citations.map((c) => c.file))) {
      const text = await readText(root, file);
      if (text) files.push({ path: file, text, size: text.length });
    }
    const occurrences = findOccurrences(files, concept.match.flatMap(matchTokens), 4);
    const { value } = await completeJson(
      this.s.ai,
      {
        slot: 'deep',
        ...conceptDetailsPrompt([{ concept, occurrences }], map.overview, this.s.store.getProfile(), feedback),
        justification: JUSTIFICATION,
      },
      conceptDetails,
      token,
    );
    const detail = value.find((d) => d.id === concept.id) ?? value[0];
    if (!detail) throw new Error('The AI reply had no new description.');
    const updated = applyDetails([concept], new Map([[concept.id, { ...detail, id: concept.id }]]), makeLookup(files))[0];
    await this.s.store.saveMap({ ...map, concepts: map.concepts.map((c) => (c.id === concept.id ? updated : c)) });
  }

  private async describeConcepts(
    concepts: Concept[],
    files: RepoFile[],
    overview: string,
    previous: RepoMap | undefined,
    hashes: Record<string, string>,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<Map<string, ConceptDetail>> {
    const details = new Map<string, ConceptDetail>();

    // Reuse descriptions whose cited files haven't changed since the last map.
    const todo: Concept[] = [];
    for (const c of concepts) {
      const old = previous?.concepts.find((p) => p.id === c.id && p.hover);
      const unchanged = old && old.citations.length > 0 && old.citations.every((ct) => previous!.fileHashes[ct.file] === hashes[ct.file]);
      if (old && unchanged) details.set(c.id, { id: c.id, hover: old.hover, usage: old.usage, citations: old.citations });
      else todo.push(c);
    }

    const batches: Concept[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    for (const [i, batch] of batches.entries()) {
      if (token.isCancellationRequested) break;
      progress.report({ message: `Describing concepts (${i + 1} of ${batches.length})…` });
      const input = batch.map((concept) => ({ concept, occurrences: findOccurrences(files, concept.match.flatMap(matchTokens), 4) }));
      try {
        const { value } = await completeJson(
          this.s.ai,
          { slot: 'standard', ...conceptDetailsPrompt(input, overview, this.s.store.getProfile()), justification: JUSTIFICATION },
          conceptDetails,
          token,
        );
        for (const d of value) details.set(d.id, d);
      } catch (e) {
        // One failed batch shouldn't lose the map; those concepts get hovers on demand.
        this.s.log.warn(`Concept batch ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return details;
  }
}

export function makeLookup(files: RepoFile[]): FileLookup {
  const cache = new Map<string, string[]>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const f = byPath.get(file);
    if (!f) return undefined;
    const lines = f.text.split(/\r?\n/);
    cache.set(file, lines);
    return lines;
  };
}

function verifySkeleton(s: MapSkeleton, lookup: FileLookup): void {
  for (const f of s.flows) if (f.entry) f.entry = verifyCitation(f.entry, lookup);
  for (const g of s.glossary) g.citations = verifyAll(g.citations, lookup);
  for (const c of s.conventions) c.evidence = verifyAll(c.evidence, lookup);
}

function applyDetails(concepts: Concept[], details: Map<string, ConceptDetail>, lookup: FileLookup): Concept[] {
  return concepts.map((c) => {
    const d = details.get(c.id);
    const merged = d ? { ...c, hover: d.hover, usage: d.usage, citations: d.citations } : c;
    return { ...merged, citations: verifyAll(merged.citations, lookup) };
  });
}
