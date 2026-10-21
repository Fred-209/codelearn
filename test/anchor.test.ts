import { describe, expect, it } from 'vitest';
import { locateQuote, trustLevel, verifyCitation, verifySteps } from '../src/learn/anchor';

const lines = [
  'public class Handler',
  '{',
  '    var all = await _payments.GetByAccountAsync(id, ct);',
  '    return all',
  '        .Where(p => p.Amount > 0)',
  '        .ToList();',
  '}',
];

describe('locateQuote', () => {
  it('confirms a quote on the claimed line', () => {
    expect(locateQuote(lines, 5, '.Where(p => p.Amount > 0)')).toBe(5);
  });

  it('corrects a wrong line number to where the quote really is', () => {
    expect(locateQuote(lines, 2, 'GetByAccountAsync')).toBe(3);
  });

  it('ignores whitespace differences', () => {
    expect(locateQuote(lines, 1, 'var all =   await')).toBe(3);
  });

  it('finds quotes that span lines', () => {
    expect(locateQuote(lines, 4, 'return all .Where(p')).toBe(4);
  });

  it('returns undefined for quotes that are not in the file', () => {
    expect(locateQuote(lines, 3, 'SaveChangesAsync')).toBeUndefined();
  });
});

describe('verifyCitation and trustLevel', () => {
  const lookup = (f: string) => (f === 'Handler.cs' ? lines : undefined);

  it('marks found quotes verified and missing files unverified', () => {
    expect(verifyCitation({ file: 'Handler.cs', line: 9, quote: 'ToList()' }, lookup)).toEqual({ file: 'Handler.cs', line: 6, quote: 'ToList()', verified: true });
    expect(verifyCitation({ file: 'Missing.cs', line: 1, quote: 'x' }, lookup).verified).toBe(false);
  });

  it('summarises trust', () => {
    expect(trustLevel([])).toBe('guess');
    expect(trustLevel([{ file: 'a', line: 1, verified: true }])).toBe('checked');
    expect(trustLevel([{ file: 'a', line: 1, verified: true }, { file: 'b', line: 1, verified: false }])).toBe('partly');
  });
});

describe('verifySteps', () => {
  it('drops steps in unknown files and fixes lines by quote', () => {
    const steps = verifySteps(
      [
        { file: 'Handler.cs', line: 1, quote: '.ToList()', title: 'Run it', body: '', concepts: [] },
        { file: 'Other.cs', line: 1, title: 'Elsewhere', body: '', concepts: [] },
        { file: 'Handler.cs', line: 99, title: 'No quote', body: '', concepts: [] },
      ],
      [{ file: 'src/Handler.cs', lines }],
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ file: 'src/Handler.cs', line: 6, verified: true });
    expect(steps[1]).toMatchObject({ line: 7, verified: false });
  });
});
