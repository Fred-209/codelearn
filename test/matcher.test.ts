import { describe, expect, it } from 'vitest';
import { ConceptIndex, identifierWords, matchGlossary, matchTokens } from '../src/learn/matcher';
import type { Concept } from '../src/store/types';

const concept = (id: string, match: string[]): Concept => ({
  id,
  name: id,
  kind: 'library',
  summary: '',
  hover: '',
  match,
  prereqs: [],
  usage: '',
  citations: [],
});

describe('matchTokens', () => {
  it('extracts identifiers from code-ish patterns', () => {
    expect(matchTokens('IRequestHandler<')).toEqual(['IRequestHandler']);
    expect(matchTokens('.Where(')).toEqual(['Where']);
    expect(matchTokens('async/await')).toEqual(['async', 'await']);
    expect(matchTokens('x')).toEqual([]);
  });
});

describe('ConceptIndex', () => {
  it('finds concepts by exact token, most specific first', () => {
    const linq = concept('linq', ['Where', 'Select', 'ToList', 'OrderBy']);
    const where = concept('linq-where', ['Where']);
    const index = new ConceptIndex([linq, where]);
    expect(index.lookup('Where').map((c) => c.id)).toEqual(['linq-where', 'linq']);
    expect(index.lookup('where')).toEqual([]);
  });
});

describe('glossary matching', () => {
  const glossary = [
    { term: 'Settlement', meaning: 'Moving money between banks', citations: [] },
    { term: 'Settlement batch', meaning: 'A group of settlements', citations: [] },
    { term: 'Payment', meaning: 'A transfer', citations: [] },
  ];

  it('splits identifiers into words', () => {
    expect(identifierWords('SettlementBatchId')).toEqual(['settlement', 'batch', 'id']);
    expect(identifierWords('HTTPClientFactory')).toEqual(['http', 'client', 'factory']);
    expect(identifierWords('settlement_batch')).toEqual(['settlement', 'batch']);
  });

  it('prefers the longest matching term', () => {
    expect(matchGlossary('SettlementBatchProcessor', glossary)?.term).toBe('Settlement batch');
    expect(matchGlossary('SettlementService', glossary)?.term).toBe('Settlement');
  });

  it('matches simple plurals and nothing unrelated', () => {
    expect(matchGlossary('pendingPayments', glossary)?.term).toBe('Payment');
    expect(matchGlossary('UserRepository', glossary)).toBeUndefined();
  });
});
