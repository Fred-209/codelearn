// Turns parsed model JSON into trusted shapes. Anything malformed is dropped
// rather than thrown, so one bad entry doesn't lose a whole scan.

import type {
  Architecture,
  ArchitectureLink,
  ArchitecturePart,
  Area,
  CheckQuestion,
  Citation,
  Comparison,
  Concept,
  ConceptKind,
  Convention,
  Flow,
  FlowStep,
  GlossaryTerm,
  KeyFile,
  WalkthroughStep,
} from '../store/types';

type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function strs(v: unknown): string[] {
  return arr(v).map((x) => str(x)).filter(Boolean);
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9#+]+/g, '-')
    .replace(/#/g, 'sharp')
    .replace(/\+/g, 'plus')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function citation(v: unknown): Citation | undefined {
  const o = obj(v);
  const file = normalizePath(str(o.file));
  const line = Number(o.line);
  if (!file || !Number.isFinite(line) || line < 1) return undefined;
  const quote = str(o.quote);
  return { file, line: Math.floor(line), ...(quote ? { quote: quote.slice(0, 200) } : {}) };
}

export function citations(v: unknown): Citation[] {
  return arr(v).map(citation).filter((c): c is Citation => !!c).slice(0, 8);
}

const KINDS: ConceptKind[] = ['language', 'library', 'pattern', 'architecture', 'domain', 'tooling'];

export function kind(v: unknown): ConceptKind {
  const k = str(v).toLowerCase() as ConceptKind;
  return KINDS.includes(k) ? k : 'pattern';
}

/** Literal code that shows a concept in use, e.g. `data-bind="`: at least 3 characters each. */
export function patterns(v: unknown): string[] {
  return [...new Set(strs(v).map((p) => p.slice(0, 80)).filter((p) => p.length >= 3))].slice(0, 6);
}

/** Concept from the map pass: everything except hover/usage, which come later. */
export function conceptSkeleton(v: unknown): Concept | undefined {
  const o = obj(v);
  const name = str(o.name);
  if (!name) return undefined;
  const pats = patterns(o.patterns);
  return {
    id: slug(str(o.id) || name),
    name,
    kind: kind(o.kind),
    summary: str(o.summary),
    hover: str(o.hover),
    match: strs(o.match).map((m) => m.slice(0, 80)).slice(0, 12),
    prereqs: strs(o.prereqs).slice(0, 8),
    usage: str(o.usage),
    citations: citations(o.citations),
    docsSite: str(o.docsSite) || undefined,
    searchQuery: str(o.searchQuery) || undefined,
    ...(pats.length ? { patterns: pats } : {}),
  };
}

export function keyFile(v: unknown): KeyFile | undefined {
  const o = obj(v);
  const file = normalizePath(str(o.file));
  return file ? { file, role: str(o.role) } : undefined;
}

export function area(v: unknown): Area | undefined {
  const o = obj(v);
  const name = str(o.name);
  if (!name) return undefined;
  const details = str(o.details);
  const keyFiles = list(o.keyFiles, keyFile, 15);
  return {
    id: slug(str(o.id) || name),
    name,
    summary: str(o.summary),
    paths: strs(o.paths).map(normalizePath),
    ...(details ? { details } : {}),
    ...(keyFiles.length ? { keyFiles } : {}),
  };
}

export function flowStep(v: unknown): FlowStep | undefined {
  const s = step(v);
  if (!s) return undefined;
  const { concepts, ...rest } = s;
  return concepts.length ? { ...rest, concepts } : rest;
}

export function flow(v: unknown): Flow | undefined {
  const o = obj(v);
  const name = str(o.name);
  if (!name) return undefined;
  const entry = citation(o.entry);
  const steps = list(o.steps, flowStep, 16);
  const part = str(o.part);
  const details = str(o.details);
  return {
    id: slug(str(o.id) || name),
    name,
    summary: str(o.summary),
    files: strs(o.files).map(normalizePath).slice(0, 15),
    ...(entry ? { entry } : {}),
    ...(steps.length ? { steps } : {}),
    ...(part ? { part: slug(part) } : {}),
    ...(details ? { details } : {}),
  };
}

export function architecturePart(v: unknown): ArchitecturePart | undefined {
  const o = obj(v);
  const name = str(o.name);
  if (!name) return undefined;
  const entry = citation(o.entry);
  const runs = str(o.runs);
  return {
    id: slug(str(o.id) || name),
    name,
    summary: str(o.summary),
    paths: strs(o.paths).map(normalizePath).slice(0, 12),
    ...(entry ? { entry } : {}),
    ...(runs ? { runs } : {}),
    ...(o.external === true ? { external: true } : {}),
  };
}

export function architectureLink(v: unknown): ArchitectureLink | undefined {
  const o = obj(v);
  const from = slug(str(o.from));
  const to = slug(str(o.to));
  const how = str(o.how);
  if (!str(o.from) || !str(o.to) || !how) return undefined;
  const evidence = citation(o.evidence);
  return { from, to, how, ...(evidence ? { evidence } : {}) };
}

/** The parts and how they connect. Links between unknown parts are dropped. */
export function architecture(v: unknown): Architecture | undefined {
  const o = obj(v);
  const parts = uniqueById(list(o.parts, architecturePart, 16));
  if (parts.length === 0) return undefined;
  const ids = new Set(parts.map((p) => p.id));
  const seen = new Set<string>();
  const links = list(o.links, architectureLink, 60).filter((l) => {
    const key = `${l.from}>${l.to}>${l.how}`;
    if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { summary: str(o.summary), parts, links };
}

export function glossaryTerm(v: unknown): GlossaryTerm | undefined {
  const o = obj(v);
  const term = str(o.term);
  const meaning = str(o.meaning);
  if (!term || !meaning) return undefined;
  return { term, meaning, citations: citations(o.citations) };
}

export function convention(v: unknown): Convention | undefined {
  const o = obj(v);
  const rule = str(o.rule);
  if (!rule) return undefined;
  const s = str(o.status).toLowerCase();
  const status = s === 'confirmed' || s === 'contradicted' ? s : 'unchecked';
  const note = str(o.note);
  return { rule, source: str(o.source) || 'code', status, ...(note ? { note } : {}), evidence: citations(o.evidence) };
}

export function comparison(v: unknown): Comparison | undefined {
  const o = obj(v);
  const known = str(o.known);
  const here = str(o.here);
  if (!known || !here) return undefined;
  return { known, here, note: str(o.note) };
}

export function checkQuestion(v: unknown): CheckQuestion | undefined {
  const o = obj(v);
  const question = str(o.question);
  const options = strs(o.options).slice(0, 5);
  const answer = Number(o.answer);
  if (!question || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) return undefined;
  return { question, options, answer, explanation: str(o.explanation) };
}

export function step(v: unknown): WalkthroughStep | undefined {
  const o = obj(v);
  const file = normalizePath(str(o.file));
  const line = Number(o.line);
  const title = str(o.title);
  if (!file || !Number.isFinite(line) || line < 1 || !title) return undefined;
  const endLine = Number(o.endLine);
  const quote = str(o.quote);
  return {
    file,
    line: Math.floor(line),
    ...(Number.isFinite(endLine) && endLine >= line ? { endLine: Math.floor(endLine) } : {}),
    ...(quote ? { quote } : {}),
    title,
    body: str(o.body),
    concepts: strs(o.concepts).slice(0, 6),
  };
}

export function list<T>(v: unknown, fn: (x: unknown) => T | undefined, max = 200): T[] {
  return arr(v)
    .map(fn)
    .filter((x): x is T => x !== undefined)
    .slice(0, max);
}

/** Removes duplicate ids, keeping the first. */
export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export interface MapSkeleton {
  overview: string;
  areas: Area[];
  flows: Flow[];
  concepts: Concept[];
  glossary: GlossaryTerm[];
  conventions: Convention[];
  architecture?: Architecture;
}

export function mapSkeleton(v: unknown): MapSkeleton {
  const o = obj(v);
  const overview = str(o.overview);
  if (!overview && arr(o.concepts).length === 0) {
    throw new Error('The AI reply did not contain a repo map.');
  }
  const arch = architecture(o.architecture);
  return {
    overview,
    areas: uniqueById(list(o.areas, area, 15)),
    flows: uniqueById(list(o.flows, flow, 16)),
    concepts: uniqueById(list(o.concepts, conceptSkeleton, 80)),
    glossary: list(o.glossary, glossaryTerm, 80),
    conventions: list(o.conventions, convention, 40),
    ...(arch ? { architecture: arch } : {}),
  };
}

/** What a deep dive found by following one flow through the code. */
export interface DiveResult {
  summary: string;
  details: string;
  part?: string;
  files: string[];
  steps: FlowStep[];
  /** Ids of known concepts at play. */
  concepts: string[];
  newConcepts: Concept[];
  glossary: GlossaryTerm[];
}

export function dive(v: unknown): DiveResult {
  const o = obj(v);
  const steps = list(o.steps, flowStep, 16);
  if (steps.length === 0) throw new Error('The AI reply had no steps for this flow.');
  const part = str(o.part);
  return {
    summary: str(o.summary),
    details: str(o.details),
    ...(part ? { part: slug(part) } : {}),
    files: strs(o.files).map(normalizePath).slice(0, 20),
    steps,
    concepts: strs(o.concepts).map(slug).slice(0, 20),
    newConcepts: uniqueById(list(o.newConcepts, conceptSkeleton, 12)),
    glossary: list(o.glossary, glossaryTerm, 12),
  };
}

/** The final big picture, written after the deep dives. */
export interface Synthesis {
  overview: string;
  architecture?: Architecture;
  areas: Area[];
}

export function synthesis(v: unknown): Synthesis {
  const o = obj(v);
  const overview = str(o.overview);
  const arch = architecture(o.architecture);
  if (!overview && !arch) throw new Error('The AI reply had no overview.');
  return { overview, ...(arch ? { architecture: arch } : {}), areas: uniqueById(list(o.areas, area, 15)) };
}

/** "Explore deeper" on one area. */
export interface AreaDetails {
  summary: string;
  details: string;
  keyFiles: KeyFile[];
  flows: Flow[];
}

export function areaDetails(v: unknown): AreaDetails {
  const o = obj(v);
  const details = str(o.details);
  if (!details) throw new Error('The AI reply had no explanation of this area.');
  return { summary: str(o.summary), details, keyFiles: list(o.keyFiles, keyFile, 15), flows: uniqueById(list(o.flows, flow, 4)) };
}

/** "Investigate": the answer to a question, as a flow through the code. */
export function investigation(v: unknown): Flow {
  const o = obj(v);
  const f = flow({ ...o, name: str(o.name) || str(o.title) });
  if (!f || (!f.details && !f.steps?.length)) throw new Error('The AI reply had no answer.');
  return f;
}

/** What "Update map" found in changed files. Throws only if the reply isn't an object at all. */
export interface MapAdditions {
  concepts: Concept[];
  glossary: GlossaryTerm[];
  flows: Flow[];
}

export function mapAdditions(v: unknown): MapAdditions {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The AI reply was not a list of map additions.');
  const o = obj(v);
  return {
    concepts: uniqueById(list(o.concepts, conceptSkeleton, 30)),
    glossary: list(o.glossary, glossaryTerm, 30),
    flows: uniqueById(list(o.flows, flow, 6)),
  };
}

export interface ConceptDetail {
  id: string;
  hover: string;
  usage: string;
  citations: Citation[];
}

export function conceptDetails(v: unknown): ConceptDetail[] {
  return list(obj(v).concepts, (x) => {
    const o = obj(x);
    const id = str(o.id);
    const hover = str(o.hover);
    if (!id || !hover) return undefined;
    return { id: slug(id), hover, usage: str(o.usage), citations: citations(o.citations) };
  });
}
