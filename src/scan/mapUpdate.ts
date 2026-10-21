// Merges what "Update map" learned into the existing map. Pure, so it can be unit tested.

import type { MapAdditions } from '../ai/normalize';
import { matchTokens } from '../learn/matcher';
import type { Concept, RepoMap } from '../store/types';
import { findOccurrences, RepoFile } from './digest';

export interface MapChanges {
  map: Pick<RepoMap, 'concepts' | 'glossary' | 'flows'>;
  added: { concepts: Concept[]; terms: number; flows: number };
  removed: { concepts: string[]; terms: number; flows: number };
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Adds what's new and drops what's gone. Something is only dropped when every file it
 * pointed at has been deleted and, for concepts, its code no longer appears anywhere.
 */
export function mergeMapUpdate(previous: RepoMap, additions: MapAdditions, files: RepoFile[]): MapChanges {
  const present = new Set(files.map((f) => f.path));
  const gone = (paths: string[]) => paths.length > 0 && paths.every((p) => !present.has(p));

  const removedConcepts: string[] = [];
  const concepts = previous.concepts.filter((c) => {
    const drop = gone(c.citations.map((ct) => ct.file)) && findOccurrences(files, c.match.flatMap(matchTokens), 1).length === 0;
    if (drop) removedConcepts.push(c.name);
    return !drop;
  });
  const glossary = previous.glossary.filter((g) => !gone(g.citations.map((ct) => ct.file)));
  const flows = previous.flows.filter((f) => !gone(f.files));

  const ids = new Set(concepts.flatMap((c) => [c.id, norm(c.name)]));
  const newConcepts = additions.concepts.filter((c) => !ids.has(c.id) && !ids.has(norm(c.name)));
  const terms = new Set(glossary.map((g) => norm(g.term)));
  const newTerms = additions.glossary.filter((g) => !terms.has(norm(g.term)));
  const flowIds = new Set(flows.flatMap((f) => [f.id, norm(f.name)]));
  const newFlows = additions.flows.filter((f) => !flowIds.has(f.id) && !flowIds.has(norm(f.name)));

  return {
    map: { concepts: [...concepts, ...newConcepts], glossary: [...glossary, ...newTerms], flows: [...flows, ...newFlows] },
    added: { concepts: newConcepts, terms: newTerms.length, flows: newFlows.length },
    removed: { concepts: removedConcepts, terms: previous.glossary.length - glossary.length, flows: previous.flows.length - flows.length },
  };
}
