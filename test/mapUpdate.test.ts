import { describe, expect, it } from 'vitest';
import { mapAdditions } from '../src/ai/normalize';
import { mapUpdatePrompt } from '../src/ai/prompts';
import { mergeMapUpdate } from '../src/scan/mapUpdate';
import type { Concept, RepoMap } from '../src/store/types';

const concept = (id: string, name: string, match: string[], files: string[]): Concept => ({
  id,
  name,
  kind: 'library',
  summary: '',
  hover: 'h',
  match,
  prereqs: [],
  usage: '',
  citations: files.map((file) => ({ file, line: 1 })),
});

const map: RepoMap = {
  version: 2,
  repoName: 'r',
  generatedAt: '',
  model: '',
  overview: 'A repo.',
  areas: [],
  flows: [{ id: 'old-flow', name: 'Old flow', summary: '', files: ['src/Old.cs'] }],
  concepts: [concept('linq', 'LINQ', ['Where'], ['src/A.cs']), concept('dapper', 'Dapper', ['QueryAsync'], ['src/Old.cs'])],
  glossary: [{ term: 'Ledger', meaning: '', citations: [{ file: 'src/Old.cs', line: 1 }] }],
  conventions: [],
  fileHashes: {},
};

const files = [
  { path: 'src/A.cs', text: 'items.Where(x => x)', size: 1 },
  { path: 'src/New.cs', text: 'await mediator.Send(cmd);', size: 1 },
];

describe('mergeMapUpdate', () => {
  it('adds new things, skips duplicates, and drops what is gone', () => {
    const additions = mapAdditions({
      concepts: [
        { id: 'mediatr', name: 'MediatR', kind: 'library', summary: 's', match: ['Send'] },
        { id: 'linq-2', name: 'linq', kind: 'library', summary: 'dup by name', match: ['Where'] },
      ],
      glossary: [{ term: 'Payout', meaning: 'm' }],
      flows: [],
    });
    const out = mergeMapUpdate(map, additions, files);
    expect(out.map.concepts.map((c) => c.id)).toEqual(['linq', 'mediatr']);
    expect(out.removed.concepts).toEqual(['Dapper']);
    expect(out.map.glossary.map((g) => g.term)).toEqual(['Payout']);
    expect(out.map.flows).toEqual([]);
    expect(out.added).toMatchObject({ terms: 1, flows: 0 });
  });

  it('keeps a concept whose file was deleted if its code still appears elsewhere', () => {
    const moved = { ...map, concepts: [concept('linq', 'LINQ', ['Where'], ['src/Gone.cs'])] };
    expect(mergeMapUpdate(moved, { concepts: [], glossary: [], flows: [] }, files).map.concepts).toHaveLength(1);
  });

  it('treats an empty reply as nothing new', () => {
    expect(mapAdditions({})).toEqual({ concepts: [], glossary: [], flows: [] });
    expect(() => mapAdditions('no')).toThrow();
  });
});

describe('mapUpdatePrompt', () => {
  it('lists what the map already covers so the model only adds new things', () => {
    const p = mapUpdatePrompt('## src/New.cs', map, undefined);
    expect(p.user).toContain('linq (LINQ)');
    expect(p.user).toContain('Ledger');
    expect(p.user).toContain('## src/New.cs');
  });
});
