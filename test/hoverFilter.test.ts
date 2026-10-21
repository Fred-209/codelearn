import { describe, expect, it } from 'vitest';
import { inCommentOrString, isProseWord, worthExplaining } from '../src/learn/hoverFilter';

const at = (line: string, word: string) => line.indexOf(word);

describe('inCommentOrString', () => {
  it('spots line comments in C-like languages, Python, SQL and shells', () => {
    expect(inCommentOrString('// the handler', 3)).toBe(true);
    expect(inCommentOrString('var x = 1; // the count', at('var x = 1; // the count', 'the'))).toBe(true);
    expect(inCommentOrString('x = 1  # the count', at('x = 1  # the count', 'the'))).toBe(true);
    expect(inCommentOrString('SELECT 1 -- the total', at('SELECT 1 -- the total', 'the'))).toBe(true);
    expect(inCommentOrString('   * the payments', 6)).toBe(true);
    expect(inCommentOrString('/// <summary>Loads</summary>', 10)).toBe(true);
  });

  it('treats code before a comment as code', () => {
    const line = 'var all = await repo.GetAll(); // load';
    expect(inCommentOrString(line, at(line, 'GetAll'))).toBe(false);
  });

  it('spots strings, and ignores comment markers inside them', () => {
    const line = 'log("the url is http://x") + count';
    expect(inCommentOrString(line, at(line, 'the'))).toBe(true);
    expect(inCommentOrString(line, at(line, 'count'))).toBe(false);
    const tpl = 'const s = `hello ${name}`;';
    expect(inCommentOrString(tpl, at(tpl, 'hello'))).toBe(true);
  });

  it("doesn't mistake directives, attributes, apostrophes or lifetimes for comments or strings", () => {
    expect(inCommentOrString('#include <vector>', 10)).toBe(false);
    expect(inCommentOrString('#[derive(Debug)]', 3)).toBe(false);
    expect(inCommentOrString('this.#count++', 7)).toBe(false);
    const rust = 'fn first<T>(x: &Vec<T>) -> Option<&T>';
    expect(inCommentOrString(rust, at(rust, 'Option'))).toBe(false);
    expect(inCommentOrString("i--; total = 0", 8)).toBe(false);
  });
});

describe('worthExplaining', () => {
  it('skips everyday English words and very short words', () => {
    expect(isProseWord('The')).toBe(true);
    expect(worthExplaining('the', 'the', 0)).toBe(false);
    expect(worthExplaining('id', 'id = 1', 0)).toBe(false);
  });

  it('offers identifiers and keywords in code', () => {
    expect(worthExplaining('IRequestHandler', ': IRequestHandler<Q, R>', 2)).toBe(true);
    expect(worthExplaining('yield', '    yield return x;', 4)).toBe(true);
  });

  it('skips identifiers inside comments and strings', () => {
    expect(worthExplaining('Handler', '// Handler for payments', 3)).toBe(false);
  });
});
