import { describe, expect, it } from 'vitest';
import { defaultScope, enclosingLabel, indentSpans, scopeLadder, SymbolSpan } from '../src/learn/codeScope';

const csharp = `namespace Payments;

public class PaymentService
{
    private readonly IRepo _repo;

    [HttpGet]
    public async Task<int> CountActive(Guid accountId)
    {
        var payments = await _repo.GetAll(accountId);
        var count = 0;
        foreach (var p in payments)
        {
            if (p.IsActive)
            {
                count++;
            }
        }
        return count;
    }
}`.split('\n');

describe('indentSpans', () => {
  it('climbs from the cursor through each enclosing block', () => {
    const spans = indentSpans(csharp, 15); // count++;
    expect(spans[0]).toEqual({ start: 15, end: 15 });
    // the if, with its header and braces
    expect(spans).toContainEqual({ start: 13, end: 16 });
    // the foreach
    expect(spans).toContainEqual({ start: 11, end: 17 });
    // the method with its signature (the attribute is a sibling line)
    expect(spans).toContainEqual({ start: 7, end: 19 });
    expect(spans.at(-1)).toEqual({ start: 0, end: csharp.length - 1 });
  });

  it('works for indentation languages', () => {
    const py = ['def total(items):', '    s = 0', '    for i in items:', '        s += i', '    return s', '', 'print(total([1]))'];
    const spans = indentSpans(py, 3);
    expect(spans).toContainEqual({ start: 2, end: 3 });
    expect(spans).toContainEqual({ start: 0, end: 4 });
  });
});

describe('scopeLadder and defaultScope', () => {
  const method: SymbolSpan = { start: 6, end: 19, name: 'CountActive', word: 'method', kind: 'function' };
  const cls: SymbolSpan = { start: 2, end: 20, name: 'PaymentService', word: 'class', kind: 'type' };
  // What a C# "Expand selection" chain looks like, as line spans.
  const syntax = [
    { start: 15, end: 15 },
    { start: 14, end: 16 },
    { start: 13, end: 16 },
    { start: 12, end: 17 },
    { start: 11, end: 17 },
    { start: 8, end: 19 },
    { start: 7, end: 19 },
    { start: 2, end: 20 },
    { start: 0, end: 20 },
  ];

  it('names spans from the outline, tolerating attributes before the syntax range', () => {
    const ladder = scopeLadder(15, csharp, syntax, [method, cls]);
    const m = ladder.find((s) => s.label === 'method CountActive');
    expect(m).toMatchObject({ start: 6, end: 19, kind: 'function' });
    expect(ladder.find((s) => s.label === 'class PaymentService')).toMatchObject({ kind: 'type' });
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].start).toBeLessThanOrEqual(ladder[i - 1].start);
      expect(ladder[i].end).toBeGreaterThanOrEqual(ladder[i - 1].end);
    }
  });

  it('picks the whole method by default, and says what is around it', () => {
    const ladder = scopeLadder(15, csharp, syntax, [method, cls]);
    const i = defaultScope(ladder);
    expect(ladder[i].label).toBe('method CountActive');
    expect(enclosingLabel(ladder, i)).toBe('class PaymentService, lines 3-21');
  });

  it('labels unnamed blocks with their first line', () => {
    const ladder = scopeLadder(15, csharp, syntax, [method, cls]);
    expect(ladder.find((s) => s.start === 13)?.label).toBe('if (p.IsActive)');
  });

  it('counts a multi-line variable as a function (arrow functions in TS/JS)', () => {
    const ts = ['export const handle = async (e: Event) => {', '  e.preventDefault();', '  await save();', '};'];
    const arrow: SymbolSpan = { start: 0, end: 3, name: 'handle', word: '', kind: 'function' };
    const ladder = scopeLadder(2, ts, [], [arrow]);
    expect(ladder[defaultScope(ladder)]).toMatchObject({ start: 0, end: 3, label: 'handle' });
  });

  it('falls back to the largest block that fits when the method is too long', () => {
    const long = ['void Big() {', ...Array.from({ length: 200 }, (_, i) => (i === 100 ? '  if (x) {' : i === 101 ? '    go();' : i === 102 ? '  }' : `  step${i}();`)), '}'];
    const big: SymbolSpan = { start: 0, end: long.length - 1, name: 'Big', word: 'method', kind: 'function' };
    const ladder = scopeLadder(102, long, [{ start: 102, end: 102 }, { start: 101, end: 103 }, { start: 0, end: long.length - 1 }], [big]);
    const i = defaultScope(ladder);
    expect(ladder[i]).toMatchObject({ start: 101, end: 103 });
    expect(enclosingLabel(ladder, i)).toBe(`method Big, lines 1-${long.length}`);
  });

  it('uses indentation when the language offers nothing', () => {
    const ladder = scopeLadder(15, csharp, [], []);
    expect(ladder.length).toBeGreaterThan(3);
    expect(ladder[defaultScope(ladder)].end - ladder[defaultScope(ladder)].start + 1).toBeLessThanOrEqual(60);
  });
});
