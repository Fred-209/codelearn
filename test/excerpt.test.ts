import { describe, expect, it } from 'vitest';
import { codeLines, excerpt } from '../src/scan/excerpt';

describe('codeLines', () => {
  it('drops a licence header and import blocks, keeping line numbers', () => {
    const text = [
      '/*',
      ' * Copyright (c) Contoso. Licensed under the MIT license.',
      ' */',
      'import { a } from "./a";',
      'import {',
      '  b,',
      '  c,',
      '} from "./bc";',
      '',
      '',
      'export class Foo {',
      '  run() { return a + b; }',
      '}',
    ].join('\n');
    expect(codeLines(text)).toEqual([
      { line: 11, text: 'export class Foo {' },
      { line: 12, text: '  run() { return a + b; }' },
      { line: 13, text: '}' },
    ]);
  });

  it('handles C# usings, Python and Go imports', () => {
    expect(codeLines('using System;\nusing Payments.Domain;\n\nnamespace X;\npublic class A {}').map((l) => l.line)).toEqual([4, 5]);
    expect(codeLines('from os import (\n  path,\n)\nimport sys\n\ndef main():\n    pass').map((l) => l.text)).toEqual(['def main():', '    pass']);
    expect(codeLines('package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {}').map((l) => l.text)).toEqual(['func main() {}']);
  });

  it('keeps a header comment that is not a licence', () => {
    expect(codeLines('// Signs users in with Azure AD.\nexport const x = 1;').length).toBe(2);
  });
});

describe('excerpt', () => {
  it('returns a short file whole, numbered', () => {
    const e = excerpt('import x from "y";\n\nconst a = 1;\nconst b = 2;', 50);
    expect(e).toEqual({ text: '3| const a = 1;\n4| const b = 2;', shown: 2, total: 2, cut: false });
  });

  it('keeps every signature of a long class and the start of each body', () => {
    const methods = Array.from({ length: 8 }, (_, i) => [
      `    public async method${i}(input: string): Promise<void> {`,
      ...Array.from({ length: 20 }, (_, j) => `        await this.step${j}(input);`),
      '    }',
      '',
    ]).flat();
    const text = ['import { A } from "./a";', '', 'export class Service {', '    private readonly cache = new Map();', '', ...methods, '}'].join('\n');
    const e = excerpt(text, 40);
    expect(e.cut).toBe(true);
    for (let i = 0; i < 8; i++) expect(e.text).toContain(`public async method${i}(input: string)`);
    expect(e.text).toContain('private readonly cache');
    expect(e.text).toContain('await this.step0(input);');
    expect(e.text).not.toContain('await this.step19(input);');
    expect(e.text).toMatch(/…\| \(\d+ more lines\)/);
    // Line numbers are the file's own.
    expect(e.text).toContain('3| export class Service {');
    expect(e.shown).toBeLessThanOrEqual(40);
  });

  it('cuts a flat file at the budget', () => {
    const text = Array.from({ length: 100 }, (_, i) => `INSERT INTO t VALUES (${i});`).join('\n');
    const e = excerpt(text, 10);
    expect(e.shown).toBe(10);
    expect(e.text.split('\n').at(-1)).toBe('…| (rest of the file not shown)');
  });
});
