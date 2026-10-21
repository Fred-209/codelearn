import * as vscode from 'vscode';
import { AIUnavailableError, completeJson } from '../ai/provider';
import { NO_PROVIDER_HELP } from '../ai/providerChoice';
import {
  areaDetails,
  conceptDetails,
  ConceptDetail,
  dive,
  DiveResult,
  investigation,
  MapAdditions,
  mapAdditions,
  mapSkeleton,
  MapSkeleton,
  slug,
  synthesis,
} from '../ai/normalize';
import { areaPrompt, conceptDetailsPrompt, divePrompt, investigatePrompt, mapContext, mapPrompt, mapUpdatePrompt, synthesisPrompt } from '../ai/prompts';
import { locateQuote, verifyAll, verifyCitation, FileLookup } from '../learn/anchor';
import { readText } from '../learn/files';
import { matchTokens } from '../learn/matcher';
import { reportError, Services } from '../services';
import type { Architecture, Area, Concept, Flow, FlowStep, GlossaryTerm, RepoMap } from '../store/types';
import { MAP_VERSION } from '../store/types';
import { addOutlines } from './collect';
import { buildDigest, changedSinceMap, deploymentSummary, estimateRequests, findOccurrences, RepoFile } from './digest';
import { mergeMapUpdate } from './mapUpdate';
import type { RepoIndex } from './repoIndex';
import { filesForQuestion, filesUnder, sourcesFor, withImports } from './sources';

const BATCH = 8;
const EXPECTED_CONCEPTS = 40;
/** Flows a Thorough map follows through the code, and how many at once. */
const MAX_DIVES = 12;
const PARALLEL = 3;
/** Most lookups the AI may make, per request. */
const DIVE_LOOKUPS = 12;
const AREA_LOOKUPS = 15;
const INVESTIGATE_LOOKUPS = 20;
/** Flows refreshed by "Update map" at most, when their code changed. */
const MAX_REFRESHED_DIVES = 4;
const JUSTIFICATION = 'codelearn reads your code to explain it to you.';

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

/**
 * Builds the repo map. Quick: one request for the big picture, then batches for concept hovers.
 * Thorough: a survey, then a deep dive along each main flow, then a synthesis of the whole.
 */
export class Scanner {
  private running = false;

  constructor(private readonly s: Services) {}

  /** True while the map is being built or changed, so two changes can't overwrite each other. */
  get busy(): boolean {
    return this.running;
  }

  async build(mode: 'full' | 'update'): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('codelearn: open a folder first.');
      return;
    }
    if (this.running) {
      vscode.window.showInformationMessage('codelearn is already working on the map. Try again when it finishes.');
      return;
    }
    const [deep, standard, providerName] = await Promise.all([this.s.ai.modelFor('deep'), this.s.ai.modelFor('standard'), this.s.ai.name()]);
    if (!deep || !standard) {
      reportError(this.s, 'Cannot build the map', new AIUnavailableError(NO_PROVIDER_HELP));
      return;
    }

    this.running = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'codelearn', cancellable: true },
        async (progress, token) => {
          progress.report({ message: 'Reading files…' });
          const snap = await this.s.files.refresh();
          if (token.isCancellationRequested) return;
          const { files, hashes } = snap;
          if (files.length === 0) {
            vscode.window.showWarningMessage('codelearn: found no code files to read in this folder.');
            return;
          }
          const lookup = makeLookup(files);
          const previous = await this.s.store.getMap();

          if (mode === 'update' && previous) {
            await this.update(previous, files, hashes, lookup, this.s.files.index(snap), standard.name, progress, token);
            return;
          }

          progress.report({ message: 'Reading symbols…' });
          const index = this.s.files.index(snap);
          await addOutlines(folder, files, index.ranked, token);
          const budget = Math.max(40_000, Math.min(deep.maxInputTokens * 2.4, 400_000));
          const digest = buildDigest(files, { repoName: folder.name, budget, index });

          const quickRequests = estimateRequests(EXPECTED_CONCEPTS, BATCH);
          const thoroughRequests = quickRequests + MAX_DIVES + 2;
          const lookupsOn = vscode.workspace.getConfiguration('codelearn').get<boolean>('ai.lookups', true);
          const choice = await vscode.window.showInformationMessage(
            `Build a map of ${folder.name}?`,
            {
              modal: true,
              detail:
                `codelearn read ${files.length} files and picked the parts that explain the repo best (about ${Math.round(digest.text.length / 1000)}k characters). Requests go through ${providerName}.\n\n` +
                `Thorough: surveys the repo with ${deep.name}, follows up to ${MAX_DIVES} main flows through the code one by one with ${standard.name}, ` +
                `then works out how all the parts fit together. About ${thoroughRequests} AI requests` +
                `${lookupsOn ? `, and the AI may search and read files as it goes (up to ${DIVE_LOOKUPS} lookups per flow; each round of lookups sends that request again, so expect several times the tokens of a Quick map)` : ''}. ` +
                'Takes 10 to 20 minutes; hovers work after the first few.\n\n' +
                `Quick: one overview with ${deep.name}, then concept descriptions with ${standard.name}. About ${quickRequests} AI requests, a few minutes.\n\n` +
                'Lessons are written later, only when you open one. Results are saved on this computer only.',
            },
            'Thorough map',
            'Quick map',
          );
          if (!choice || token.isCancellationRequested) return;
          const ctx: BuildContext = { folder, files, hashes, lookup, index, digest: digest.text, previous, progress, token, deepName: deep.name, standardName: standard.name };
          if (choice === 'Quick map') await this.quick(ctx);
          else await this.thorough(ctx);
        },
      );
    } finally {
      this.running = false;
    }
  }

  private async quick(c: BuildContext): Promise<void> {
    c.progress.report({ message: `Mapping the repo with ${c.deepName}… (this can take a few minutes)` });
    const { value: skeleton, model } = await completeJson(
      this.s.ai,
      { slot: 'deep', ...mapPrompt(c.digest, this.s.store.getProfile(), 'quick'), justification: JUSTIFICATION, purpose: 'build map' },
      mapSkeleton,
      c.token,
    );
    verifySkeleton(skeleton, c.lookup);
    const details = await this.describeConcepts(skeleton.concepts, c.files, skeleton.overview, c.previous, c.hashes, c.progress, c.token);
    const map = await this.newMap(c, skeleton, model, 'quick');
    map.concepts = applyDetails(skeleton.concepts, details, c.lookup);
    await this.s.store.saveMap(map);
    this.s.log.info(`Quick map built: ${map.concepts.length} concepts, ${map.flows.length} flows, ${map.glossary.length} terms.`);
    vscode.window.showInformationMessage(
      `codelearn mapped ${c.folder.name}: ${map.areas.length} areas, ${map.flows.length} flows, ${map.concepts.length} concepts. Hover over code to start, or open the codelearn sidebar.`,
    );
  }

  private async thorough(c: BuildContext): Promise<void> {
    const profile = this.s.store.getProfile();
    c.progress.report({ message: `Surveying the repo with ${c.deepName}… (a few minutes)` });
    const { value: survey, model } = await completeJson(
      this.s.ai,
      {
        slot: 'deep',
        ...mapPrompt(c.digest, profile, 'thorough'),
        justification: JUSTIFICATION,
        purpose: 'build map: survey',
        // No lookups: it is the largest request, and every round of lookups would send it again.
      },
      mapSkeleton,
      c.token,
    );
    verifySkeleton(survey, c.lookup);

    // Hovers first, so the map is useful while the flows are followed.
    const details = await this.describeConcepts(survey.concepts, c.files, survey.overview, c.previous, c.hashes, c.progress, c.token);
    let map = await this.newMap(c, survey, model, 'thorough');
    map.concepts = applyDetails(survey.concepts, details, c.lookup);
    await this.s.store.saveMap(map);
    if (c.token.isCancellationRequested) return;

    const targets = survey.flows.slice(0, MAX_DIVES);
    let done = 0;
    c.progress.report({ message: `Following the main flows through the code (0 of ${targets.length})…` });
    const dives = await pool(targets, PARALLEL, async (flow) => {
      try {
        return c.token.isCancellationRequested ? undefined : await this.dive(flow, map, c.files, c.index, c.token);
      } catch (e) {
        // One failed dive shouldn't lose the map; the flow keeps what the survey said.
        if (!c.token.isCancellationRequested) this.s.log.warn(`Following "${flow.name}" failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      } finally {
        c.progress.report({ message: `Following the main flows through the code (${++done} of ${targets.length})…` });
      }
    });
    const found = collectDiscoveries(map, dives);
    map = {
      ...map,
      flows: map.flows.map((f) => {
        const i = targets.indexOf(f);
        return i >= 0 && dives[i] ? applyDive(f, dives[i]!, c.lookup) : f;
      }),
      glossary: [...map.glossary, ...found.terms],
    };
    if (c.token.isCancellationRequested) return this.save(map);

    c.progress.report({ message: `Putting the whole picture together with ${c.deepName}…` });
    try {
      const { value } = await completeJson(
        this.s.ai,
        {
          slot: 'deep',
          ...synthesisPrompt(map, map.flows, deploymentSummary(c.files), profile),
          justification: JUSTIFICATION,
          purpose: 'build map: synthesis',
        },
        synthesis,
        c.token,
      );
      const architecture = value.architecture ? verifyArchitecture(value.architecture, c.lookup) : map.architecture;
      map = { ...map, overview: value.overview || map.overview, ...(architecture ? { architecture } : {}), areas: value.areas.length ? value.areas : map.areas };
    } catch (e) {
      if (!c.token.isCancellationRequested) this.s.log.warn(`The final synthesis failed, so the survey's overview stays: ${e instanceof Error ? e.message : e}`);
    }

    if (found.concepts.length && !c.token.isCancellationRequested) {
      const more = await this.describeConcepts(found.concepts, c.files, map.overview, undefined, c.hashes, c.progress, c.token);
      map = { ...map, concepts: [...map.concepts, ...applyDetails(found.concepts, more, c.lookup)] };
    }
    await this.save(map);
    const followed = dives.filter(Boolean).length;
    this.s.log.info(`Thorough map built: ${map.concepts.length} concepts, ${map.flows.length} flows (${followed} followed), ${map.architecture?.parts.length ?? 0} parts.`);
    vscode.window.showInformationMessage(
      `codelearn mapped ${c.folder.name}: ${map.architecture?.parts.length ?? 0} parts, ${map.flows.length} flows (${followed} followed step by step), ${map.concepts.length} concepts. Open the codelearn sidebar to start with the Architecture.`,
    );
  }

  private async newMap(c: BuildContext, skeleton: MapSkeleton, model: string, depth: 'quick' | 'thorough'): Promise<RepoMap> {
    const git = await this.s.store.gitState();
    return {
      version: MAP_VERSION,
      repoName: git?.name ?? c.folder.name,
      generatedAt: new Date().toISOString(),
      model,
      ...skeleton,
      fileHashes: c.hashes,
      builtFrom: { branch: git?.branch, commit: git?.commit },
      depth,
    };
  }

  private async save(map: RepoMap): Promise<void> {
    await this.s.store.saveMap({ ...map, generatedAt: new Date().toISOString() });
  }

  /** One deep dive: the flow's files and what they use, step by step. */
  private async dive(flow: Flow, map: RepoMap, files: RepoFile[], index: RepoIndex, token: vscode.CancellationToken): Promise<DiveResult> {
    const seeds = flow.files.length ? flow.files : flow.entry ? [flow.entry.file] : [];
    const lookups = await this.s.files.lookups(DIVE_LOOKUPS);
    const sources = sourcesFor(files, withImports(seeds, index, 14), lookups ? 40_000 : 60_000);
    if (sources.length === 0) throw new Error(`none of its files could be read`);
    const { value } = await completeJson(
      this.s.ai,
      {
        slot: 'standard',
        ...divePrompt(flow, sources, mapContext(map), map.concepts, this.s.store.getProfile()),
        justification: JUSTIFICATION,
        purpose: `build map: flow "${flow.name}"`,
        lookups,
      },
      dive,
      token,
    );
    return value;
  }

  /**
   * Brings the map up to date with the files that changed since it was built: finds new
   * concepts, terms and flows in them (one request), drops ones whose code is gone, re-describes
   * concepts the changes touch, and follows again the flows whose code changed. Re-checks every
   * citation and step.
   */
  private async update(
    previous: RepoMap,
    files: RepoFile[],
    hashes: Record<string, string>,
    lookup: FileLookup,
    index: RepoIndex,
    standardName: string,
    progress: Progress,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const changed = changedSinceMap(previous, hashes);
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
      (c) => c.citations.some((ct) => changed.has(ct.file)) || findOccurrences(changedText, c.match.flatMap(matchTokens), 1).length > 0,
    );
    const stale = previous.flows
      .filter((f) => f.steps?.length && [...f.files, ...f.steps.map((st) => st.file)].some((p) => changed.has(p)))
      .slice(0, MAX_REFRESHED_DIVES);
    const requests = (changedText.length ? 1 : 0) + Math.ceil(touched.length / BATCH) + stale.length;
    const ok = await vscode.window.showInformationMessage(
      `${changed.size} files changed since the map was built.`,
      {
        modal: true,
        detail:
          `codelearn will look for new concepts, terms and flows in the changed files, refresh ${touched.length} existing concepts` +
          `${stale.length ? ` and follow ${stale.length} changed ${stale.length === 1 ? 'flow' : 'flows'} through the code again` : ''}, ` +
          `using ${standardName}: about ${requests} AI requests, plus one per 8 new concepts it finds.`,
      },
      'Update map',
    );
    if (ok !== 'Update map' || token.isCancellationRequested) return;

    let additions: MapAdditions = { concepts: [], glossary: [], flows: [] };
    if (changedText.length) {
      progress.report({ message: 'Looking for new concepts in the changed files…' });
      const digest = buildDigest(changedText, { repoName: previous.repoName, budget: 80_000 });
      try {
        ({ value: additions } = await completeJson(
          this.s.ai,
          { slot: 'standard', ...mapUpdatePrompt(digest.text, previous, this.s.store.getProfile()), justification: JUSTIFICATION, purpose: 'update map' },
          mapAdditions,
          token,
        ));
      } catch (e) {
        // Still refresh what's there; new things can be found next time.
        this.s.log.warn(`Looking for new concepts failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    const merged = mergeMapUpdate(previous, additions, files);
    const refresh = [...touched.filter((c) => merged.map.concepts.includes(c)), ...merged.added.concepts];
    const details = await this.describeConcepts(refresh, files, previous.overview, undefined, hashes, progress, token);
    const skeleton: MapSkeleton = {
      overview: previous.overview,
      areas: previous.areas,
      flows: merged.map.flows,
      concepts: merged.map.concepts,
      glossary: merged.map.glossary,
      conventions: previous.conventions,
    };
    verifySkeleton(skeleton, lookup);
    let flows = skeleton.flows.map((f) => (f.steps ? { ...f, steps: verifyFlowSteps(f.steps, lookup) } : f));

    let refreshed = 0;
    if (stale.length && !token.isCancellationRequested) {
      progress.report({ message: `Following ${stale.length} changed ${stale.length === 1 ? 'flow' : 'flows'} again…` });
      const base: RepoMap = { ...previous, flows };
      const dives = await pool(stale, PARALLEL, (f) => this.dive(f, base, files, index, token).catch(() => undefined));
      flows = flows.map((f) => {
        const i = stale.findIndex((x) => x.id === f.id);
        if (i < 0 || !dives[i]) return f;
        refreshed++;
        return applyDive(f, dives[i]!, lookup);
      });
    }

    const git = await this.s.store.gitState();
    const map: RepoMap = {
      ...previous,
      ...skeleton,
      flows,
      concepts: applyDetails(skeleton.concepts, details, lookup),
      fileHashes: hashes,
      generatedAt: new Date().toISOString(),
      builtFrom: { branch: git?.branch, commit: git?.commit },
      templatesUntracked: undefined,
    };
    await this.s.store.saveMap(map);

    const news = [
      merged.added.concepts.length && `${merged.added.concepts.length} new concepts`,
      merged.added.terms && `${merged.added.terms} new terms`,
      merged.added.flows && `${merged.added.flows} new flows`,
      refreshed && `${refreshed} flows followed again`,
      merged.removed.concepts.length && `${merged.removed.concepts.length} concepts removed`,
    ].filter(Boolean);
    vscode.window.showInformationMessage(
      `codelearn updated the map from ${changed.size} changed files: ${touched.length} concepts refreshed${news.length ? `, ${news.join(', ')}` : ''}.`,
    );
  }

  /**
   * "Investigate": answers a question about the repo as a new flow through the code. One
   * request, with lookups so the AI can search for what the question is about.
   */
  async investigate(question: string): Promise<Flow | undefined> {
    const map = await this.mapForChange();
    if (!map) return undefined;
    this.running = true;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `codelearn: investigating “${question}”…`, cancellable: true },
        async (_progress, token) => {
          const snap = await this.s.files.get();
          const index = this.s.files.index(snap);
          const lookups = await this.s.files.lookups(INVESTIGATE_LOOKUPS);
          const paths = withImports(filesForQuestion(question, snap.files, index, 8), index, 12);
          const sources = sourcesFor(snap.files, paths, lookups ? 30_000 : 50_000, 160);
          const { value } = await completeJson(
            this.s.ai,
            {
              slot: 'standard',
              ...investigatePrompt(question, sources, mapContext(map), map.concepts, this.s.store.getProfile()),
              justification: JUSTIFICATION,
              purpose: `investigate: ${question}`,
              lookups,
            },
            investigation,
            token,
          );
          const lookup = makeLookup(snap.files);
          const flow: Flow = {
            ...value,
            id: uniqueId(`q-${value.id}`, (await this.s.store.getMap())?.flows ?? []),
            question,
            files: value.files.filter((f) => !!lookup(f)),
            ...(value.entry ? { entry: verifyCitation(value.entry, lookup) } : {}),
            ...(value.steps ? { steps: verifyFlowSteps(value.steps, lookup) } : {}),
          };
          const latest = (await this.s.store.getMap()) ?? map;
          await this.s.store.saveMap({ ...latest, flows: [...latest.flows, flow] });
          return flow;
        },
      );
    } finally {
      this.running = false;
    }
  }

  /** "Explore deeper": a fuller explanation of one area, its key files, and paths through it. */
  async exploreArea(areaId: string): Promise<Area | undefined> {
    const map = await this.mapForChange();
    const area = map?.areas.find((a) => a.id === areaId);
    if (!map || !area) return undefined;
    this.running = true;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `codelearn: exploring ${area.name}…`, cancellable: true },
        async (_progress, token) => {
          const snap = await this.s.files.get();
          const index = this.s.files.index(snap);
          let paths = filesUnder(area.paths, index, 14);
          if (paths.length === 0) paths = (area.keyFiles ?? []).map((k) => k.file);
          const lookups = await this.s.files.lookups(AREA_LOOKUPS);
          const sources = sourcesFor(snap.files, paths, lookups ? 40_000 : 60_000, 160);
          const { value } = await completeJson(
            this.s.ai,
            {
              slot: 'standard',
              ...areaPrompt(area, sources, mapContext(map), map.concepts, this.s.store.getProfile()),
              justification: JUSTIFICATION,
              purpose: `explore area: ${area.name}`,
              lookups,
            },
            areaDetails,
            token,
          );
          const lookup = makeLookup(snap.files);
          const updated: Area = {
            ...area,
            summary: value.summary || area.summary,
            details: value.details,
            keyFiles: value.keyFiles.filter((k) => !!lookup(k.file)),
          };
          const latest = (await this.s.store.getMap()) ?? map;
          const flows = value.flows
            .filter((f) => f.steps?.length)
            .map((f) => ({ ...f, id: uniqueId(f.id, latest.flows), steps: verifyFlowSteps(f.steps!, lookup), files: f.files.filter((x) => !!lookup(x)) }));
          await this.s.store.saveMap({ ...latest, areas: latest.areas.map((a) => (a.id === area.id ? updated : a)), flows: [...latest.flows, ...flows] });
          return updated;
        },
      );
    } finally {
      this.running = false;
    }
  }

  /** The map, when it exists and nothing else is changing it. */
  private async mapForChange(): Promise<RepoMap | undefined> {
    if (this.running) {
      vscode.window.showInformationMessage('codelearn is already working on the map. Try again when it finishes.');
      return undefined;
    }
    const map = await this.s.store.getMap();
    if (!map) {
      const choice = await vscode.window.showInformationMessage('codelearn: build the map first.', 'Build map');
      if (choice) void vscode.commands.executeCommand('codelearn.buildMap');
    }
    return map;
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
    const occurrences = findOccurrences(files, concept.match.flatMap(matchTokens), 4, concept.patterns);
    const { value } = await completeJson(
      this.s.ai,
      {
        slot: 'deep',
        ...conceptDetailsPrompt([{ concept, occurrences }], map.overview, this.s.store.getProfile(), feedback),
        justification: JUSTIFICATION,
        purpose: `rewrite: ${concept.name}`,
      },
      conceptDetails,
      token,
    );
    const detail = value.find((d) => d.id === concept.id) ?? value[0];
    if (!detail) throw new Error('The AI reply had no new description.');
    const updated = applyDetails([concept], new Map([[concept.id, { ...detail, id: concept.id }]]), makeLookup(files))[0];
    const latest = (await this.s.store.getMap()) ?? map;
    await this.s.store.saveMap({ ...latest, concepts: latest.concepts.map((c) => (c.id === concept.id ? updated : c)) });
  }

  private async describeConcepts(
    concepts: Concept[],
    files: RepoFile[],
    overview: string,
    previous: RepoMap | undefined,
    hashes: Record<string, string>,
    progress: Progress,
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
    let done = 0;
    if (batches.length) progress.report({ message: `Describing concepts (0 of ${batches.length})…` });
    await pool(batches, PARALLEL, async (batch, i) => {
      if (token.isCancellationRequested) return;
      const input = batch.map((concept) => ({ concept, occurrences: findOccurrences(files, concept.match.flatMap(matchTokens), 4, concept.patterns) }));
      try {
        const { value } = await completeJson(
          this.s.ai,
          { slot: 'standard', ...conceptDetailsPrompt(input, overview, this.s.store.getProfile()), justification: JUSTIFICATION, purpose: 'describe concepts' },
          conceptDetails,
          token,
        );
        for (const d of value) details.set(d.id, d);
      } catch (e) {
        // One failed batch shouldn't lose the map; those concepts get hovers on demand.
        this.s.log.warn(`Concept batch ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        progress.report({ message: `Describing concepts (${++done} of ${batches.length})…` });
      }
    });
    return details;
  }
}

interface BuildContext {
  folder: vscode.WorkspaceFolder;
  files: RepoFile[];
  hashes: Record<string, string>;
  lookup: FileLookup;
  index: RepoIndex;
  digest: string;
  previous: RepoMap | undefined;
  progress: Progress;
  token: vscode.CancellationToken;
  deepName: string;
  standardName: string;
}

/** Runs `fn` over `items`, at most `size` at a time, keeping the order of results. */
export async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
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

/** Moves each step to where its quote really is, and drops steps in files that don't exist. */
export function verifyFlowSteps(steps: FlowStep[], lookup: FileLookup): FlowStep[] {
  const out: FlowStep[] = [];
  for (const st of steps) {
    const lines = lookup(st.file);
    if (!lines) continue;
    const found = st.quote ? locateQuote(lines, st.line, st.quote) : undefined;
    const line = found ?? Math.min(st.line, Math.max(lines.length, 1));
    const span = st.endLine ? st.endLine - st.line : 0;
    out.push({ ...st, line, ...(st.endLine ? { endLine: Math.min(line + span, lines.length) } : {}), verified: !!found });
  }
  return out;
}

/** A flow with what its deep dive found. Keeps the survey's version of anything the dive lacks. */
export function applyDive(flow: Flow, d: DiveResult, lookup: FileLookup): Flow {
  const steps = verifyFlowSteps(d.steps, lookup);
  const files = d.files.filter((f) => !!lookup(f));
  return {
    ...flow,
    summary: d.summary || flow.summary,
    ...(d.details ? { details: d.details } : {}),
    ...(d.part || flow.part ? { part: d.part || flow.part } : {}),
    files: files.length ? files : flow.files,
    ...(steps.length ? { steps } : {}),
  };
}

/** New concepts and terms the dives met, not already in the map (by id, name or term). */
export function collectDiscoveries(map: RepoMap, dives: (DiveResult | undefined)[]): { concepts: Concept[]; terms: GlossaryTerm[] } {
  const known = new Set(map.concepts.flatMap((c) => [c.id, slug(c.name)]));
  const concepts: Concept[] = [];
  for (const c of dives.flatMap((d) => d?.newConcepts ?? [])) {
    if (known.has(c.id) || known.has(slug(c.name))) continue;
    known.add(c.id).add(slug(c.name));
    concepts.push(c);
  }
  const terms = new Set(map.glossary.map((g) => g.term.toLowerCase()));
  const glossary: GlossaryTerm[] = [];
  for (const g of dives.flatMap((d) => d?.glossary ?? [])) {
    if (terms.has(g.term.toLowerCase())) continue;
    terms.add(g.term.toLowerCase());
    glossary.push(g);
  }
  return { concepts: concepts.slice(0, 24), terms: glossary };
}

function verifySkeleton(s: MapSkeleton, lookup: FileLookup): void {
  for (const f of s.flows) if (f.entry) f.entry = verifyCitation(f.entry, lookup);
  for (const g of s.glossary) g.citations = verifyAll(g.citations, lookup);
  for (const c of s.conventions) c.evidence = verifyAll(c.evidence, lookup);
  if (s.architecture) s.architecture = verifyArchitecture(s.architecture, lookup);
}

function verifyArchitecture(a: Architecture, lookup: FileLookup): Architecture {
  return {
    ...a,
    parts: a.parts.map((p) => (p.entry ? { ...p, entry: verifyCitation(p.entry, lookup) } : p)),
    links: a.links.map((l) => (l.evidence ? { ...l, evidence: verifyCitation(l.evidence, lookup) } : l)),
  };
}

function applyDetails(concepts: Concept[], details: Map<string, ConceptDetail>, lookup: FileLookup): Concept[] {
  return concepts.map((c) => {
    const d = details.get(c.id);
    const merged = d ? { ...c, hover: d.hover, usage: d.usage, citations: d.citations } : c;
    return { ...merged, citations: verifyAll(merged.citations, lookup) };
  });
}

function uniqueId(id: string, flows: { id: string }[]): string {
  const ids = new Set(flows.map((f) => f.id));
  if (!ids.has(id)) return id;
  for (let i = 2; ; i++) if (!ids.has(`${id}-${i}`)) return `${id}-${i}`;
}
