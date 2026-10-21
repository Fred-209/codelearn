// Upgrades saved data from older versions of codelearn, so a new release never makes you
// rebuild a map or regenerate lessons. Pure, so every migration can be unit tested.

import type { Explanation, Lesson, RepoMap, Walkthrough } from './types';
import { MAP_VERSION } from './types';

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * Brings a saved map up to the current shape. Each step upgrades one version; fields a step
 * doesn't know about are kept. A map written by a newer codelearn is read as-is (best effort).
 */
export function migrateMap(raw: unknown): RepoMap | undefined {
  if (!isObj(raw)) return undefined;
  let m: Raw = { ...raw };
  let version = typeof m.version === 'number' ? m.version : 1;

  if (version < 2) {
    // v2 added builtFrom (branch and commit). Older maps simply don't know theirs.
    m = { ...m, builtFrom: undefined };
    version = 2;
  }
  if (version < 3) {
    // v3 reads templates (.html, .liquid, ...) too. These maps never hashed them, so they
    // mustn't show up as changed files. Everything else v3 adds is optional.
    m = { ...m, depth: 'quick', templatesUntracked: true };
    version = 3;
  }
  // Future steps go here: if (version < 4) { ...; version = 4; }

  return {
    ...(m as unknown as RepoMap),
    version: Math.max(version, MAP_VERSION),
    repoName: str(m.repoName, 'repository'),
    generatedAt: str(m.generatedAt),
    model: str(m.model),
    overview: str(m.overview),
    areas: arr<RepoMap['areas'][number]>(m.areas).map((a) => ({ ...a, paths: arr(a.paths) })),
    flows: arr<RepoMap['flows'][number]>(m.flows).map((f) => ({ ...f, files: arr(f.files) })),
    concepts: arr<RepoMap['concepts'][number]>(m.concepts).map((c) => ({
      ...c,
      match: arr(c.match),
      prereqs: arr(c.prereqs),
      citations: arr(c.citations),
      hover: str(c.hover),
      usage: str(c.usage),
      summary: str(c.summary),
    })),
    glossary: arr(m.glossary),
    conventions: arr(m.conventions),
    fileHashes: isObj(m.fileHashes) ? (m.fileHashes as Record<string, string>) : {},
  };
}

export function migrateLesson(raw: unknown): Lesson | undefined {
  if (!isObj(raw) || typeof raw.body !== 'string') return undefined;
  return {
    ...(raw as unknown as Lesson),
    comparisons: arr(raw.comparisons),
    pitfalls: arr(raw.pitfalls),
    citations: arr(raw.citations),
    docs: arr<{ title?: unknown; url?: unknown }>(raw.docs).filter((d) => typeof d?.url === 'string' && /^https:\/\//.test(d.url)) as Lesson['docs'],
    usage: str(raw.usage),
    model: str(raw.model),
    generatedAt: str(raw.generatedAt),
    sourceHash: str(raw.sourceHash),
  };
}

export function migrateExplanation(raw: unknown): Explanation | undefined {
  if (!isObj(raw) || typeof raw.body !== 'string') return undefined;
  return { ...(raw as unknown as Explanation), conceptIds: arr(raw.conceptIds), citations: arr(raw.citations), title: str(raw.title, 'Explanation') };
}

export function migrateWalkthrough(raw: unknown): Walkthrough | undefined {
  if (!isObj(raw) || !Array.isArray(raw.steps) || raw.steps.length === 0) return undefined;
  return {
    ...(raw as unknown as Walkthrough),
    steps: arr<Walkthrough['steps'][number]>(raw.steps).map((s) => ({ ...s, concepts: arr(s.concepts) })),
  };
}
