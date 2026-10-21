import { describe, expect, it } from 'vitest';
import { checkQuestion, conceptDetails, mapSkeleton, slug, step } from '../src/ai/normalize';

describe('mapSkeleton', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const map = mapSkeleton({
      overview: 'A payments API.',
      areas: [{ name: 'API', summary: 'HTTP layer', paths: ['src\\Api'] }, { summary: 'no name' }],
      flows: [{ name: 'Create payment', files: ['./src/Api/PaymentsController.cs'], entry: { file: 'src/Api/PaymentsController.cs', line: 12, quote: '[HttpPost]' } }],
      concepts: [
        { id: 'MediatR', name: 'MediatR', kind: 'library', match: ['IMediator', 'Send'] },
        { name: 'MediatR', kind: 'library' },
        { name: 'Weird kind', kind: 'banana' },
        'not an object',
      ],
      glossary: [{ term: 'Settlement', meaning: 'Moving money', citations: [{ file: 'x.cs', line: 0 }] }],
      conventions: [{ rule: 'Every command has a validator', source: 'AGENTS.md', status: 'CONTRADICTED', note: 'Two commands lack one' }],
    });
    expect(map.areas).toHaveLength(1);
    expect(map.areas[0].paths).toEqual(['src/Api']);
    expect(map.flows[0].files).toEqual(['src/Api/PaymentsController.cs']);
    expect(map.concepts.map((c) => c.id)).toEqual(['mediatr', 'weird-kind']);
    expect(map.concepts[1].kind).toBe('pattern');
    expect(map.glossary[0].citations).toEqual([]);
    expect(map.conventions[0].status).toBe('contradicted');
  });

  it('rejects a reply with no map', () => {
    expect(() => mapSkeleton({ hello: 'world' })).toThrow();
  });
});

describe('other normalizers', () => {
  it('slugs names safely', () => {
    expect(slug('C# Records')).toBe('csharp-records');
    expect(slug('C++ templates')).toBe('cplusplus-templates');
    expect(slug('  Dependency Injection! ')).toBe('dependency-injection');
  });

  it('validates check questions', () => {
    expect(checkQuestion({ question: 'Q?', options: ['a', 'b'], answer: 1, explanation: 'e' })).toBeDefined();
    expect(checkQuestion({ question: 'Q?', options: ['a', 'b'], answer: 2 })).toBeUndefined();
    expect(checkQuestion({ question: 'Q?', options: ['a'], answer: 0 })).toBeUndefined();
  });

  it('validates walkthrough steps', () => {
    expect(step({ file: 'a.cs', line: 3, title: 'T', body: 'B', endLine: 2 })).toEqual({ file: 'a.cs', line: 3, title: 'T', body: 'B', concepts: [] });
    expect(step({ file: 'a.cs', line: 'x', title: 'T' })).toBeUndefined();
  });

  it('reads concept details', () => {
    expect(conceptDetails({ concepts: [{ id: 'LINQ', hover: 'Queries.', usage: 'Used in handlers.', citations: [{ file: 'a.cs', line: 2, quote: 'Where' }] }, { id: 'x' }] })).toEqual([
      { id: 'linq', hover: 'Queries.', usage: 'Used in handlers.', citations: [{ file: 'a.cs', line: 2, quote: 'Where' }] },
    ]);
  });
});
