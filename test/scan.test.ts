import { describe, expect, it } from 'vitest';
import { classify, folderSummary, isLowValue, pathPriority, regexOutline } from '../src/scan/classify';
import { buildDigest, changedFiles, findOccurrences, numbered, RepoFile } from '../src/scan/digest';

describe('classify', () => {
  it('recognises AI instruction and convention files', () => {
    for (const p of [
      'AGENTS.md',
      'src/Payments/AGENTS.md',
      'CLAUDE.md',
      '.github/copilot-instructions.md',
      '.github/instructions/csharp.instructions.md',
      '.cursor/rules/api.mdc',
      '.claude/skills/review/SKILL.md',
      'CONTRIBUTING.md',
      'docs/adr/0001-use-mediatr.md',
      'README.md',
    ]) {
      expect(classify(p), p).toBe('instruction');
    }
  });

  it('recognises manifests, code and everything else', () => {
    expect(classify('src/Payments.Api/Payments.Api.csproj')).toBe('manifest');
    expect(classify('package.json')).toBe('manifest');
    expect(classify('src/Payments.Api/appsettings.Production.json')).toBe('manifest');
    expect(classify('src/Handlers/CreatePayment.cs')).toBe('code');
    expect(classify('app/main.py')).toBe('code');
    expect(classify('src/components/signin/signin.html')).toBe('template');
    expect(classify('templates/page.liquid')).toBe('template');
    expect(classify('Views/Home/Index.cshtml')).toBe('code');
    expect(classify('assets/logo.png')).toBe('other');
  });
});

describe('pathPriority and isLowValue', () => {
  it('keeps instructions and manifests, then startup files, then other code, then templates, then examples and tests', () => {
    const p = (path: string) => pathPriority(path, classify(path));
    expect(p('AGENTS.md')).toBeGreaterThan(p('package.json'));
    expect(p('package.json')).toBeGreaterThan(p('src/startup.design.ts'));
    expect(p('src/startup.design.ts')).toBeGreaterThan(p('src/services/usersService.ts'));
    expect(p('src/services/usersService.ts')).toBeGreaterThan(p('src/components/signin/signin.html'));
    expect(p('src/components/signin/signin.html')).toBeGreaterThan(p('examples/widget/index.ts'));
  });

  it('treats tests, examples, scaffolds and generated code as low value', () => {
    for (const path of ['tests/a.ts', 'src/a.spec.ts', 'examples/x/y.ts', 'scaffolds/widget/w.ts', 'community/widgets/a.ts', 'src/types.d.ts', 'Migrations/2024_Init.cs', 'src/Foo.Designer.cs']) {
      expect(isLowValue(path), path).toBe(true);
    }
    for (const path of ['src/startup.runtime.ts', 'src/services/usersService.ts', 'src/Payments.Api/Program.cs']) {
      expect(isLowValue(path), path).toBe(false);
    }
  });
});

describe('regexOutline', () => {
  it('finds declarations in several languages', () => {
    const cs = 'namespace X;\npublic sealed class Foo : IBar\n{\n  public async Task<int> Run(int a)\n  {\n  }\n}';
    expect(regexOutline(cs)).toEqual(['1: namespace X;', '2: public sealed class Foo : IBar', '4: public async Task<int> Run(int a)']);
    expect(regexOutline('def main():\n    pass\nclass Thing:\n    pass')).toEqual(['1: def main():', '3: class Thing:']);
    expect(regexOutline('export function go() {}\nconst x = 1;')).toEqual(['1: export function go() {}']);
  });
});

describe('buildDigest', () => {
  const files: RepoFile[] = [
    { path: 'AGENTS.md', text: 'Every command has a validator.', size: 30 },
    { path: 'src/Api/Api.csproj', text: '<PackageReference Include="MediatR" />', size: 40 },
    { path: 'src/Api/Program.cs', text: 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddMediatR();', size: 80 },
    { path: 'src/App/Handler.cs', text: 'public class Handler : IRequestHandler<Cmd>\n{\n}', size: 50 },
  ];

  it('includes instructions, manifests and code samples', () => {
    const d = buildDigest(files, { repoName: 'Payments', budget: 50_000 });
    expect(d.text).toContain('# Repository: Payments');
    expect(d.text).toContain('Every command has a validator.');
    expect(d.text).toContain('MediatR');
    expect(d.text).toContain('1| var builder');
    expect(d.text).toContain('## Entry points');
    expect(d.text).toContain('- src/Api/Program.cs: ');
    expect(d.sampledFiles[0]).toBe('src/Api/Program.cs');
    expect(d.sampledFiles).toContain('src/App/Handler.cs');
  });

  it('stays within budget', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ path: `src/F${i}/File${i}.cs`, text: 'public class X {}\n'.repeat(400), size: 7000 }));
    const d = buildDigest(big, { repoName: 'Big', budget: 30_000 });
    expect(d.text.length).toBeLessThan(33_000);
    expect(d.sampledFiles.length).toBeGreaterThan(0);
  });
});

describe('findOccurrences', () => {
  it('finds whole-word matches, one per file', () => {
    const files: RepoFile[] = [
      { path: 'a.cs', text: 'var x = items.Where(i => i.Ok);\nvar y = other.Where(z);', size: 1 },
      { path: 'b.cs', text: 'var Wherever = 1;', size: 1 },
      { path: 'c.cs', text: 'list.Where(q)', size: 1 },
    ];
    expect(findOccurrences(files, ['Where'], 4)).toEqual([
      { file: 'a.cs', line: 1, text: 'var x = items.Where(i => i.Ok);' },
      { file: 'c.cs', line: 1, text: 'list.Where(q)' },
    ]);
  });

  it('finds literal patterns in templates, real code before tests', () => {
    const files: RepoFile[] = [
      { path: 'tests/signin.spec.ts', text: 'ko.observable(1)', size: 1 },
      { path: 'src/signin.html', text: '<div>\n  <input data-bind="value: username" />\n</div>', size: 1 },
      { path: 'src/signin.ts', text: 'this.username = ko.observable("");', size: 1 },
    ];
    expect(findOccurrences(files, [], 4, ['data-bind=', 'ko.observable('])).toEqual([
      { file: 'src/signin.html', line: 2, text: '<input data-bind="value: username" />' },
      { file: 'src/signin.ts', line: 1, text: 'this.username = ko.observable("");' },
      { file: 'tests/signin.spec.ts', line: 1, text: 'ko.observable(1)' },
    ]);
  });
});

describe('helpers', () => {
  it('numbers lines from a start line', () => {
    expect(numbered('a\nb\nc', 2, 2)).toBe('2| b\n3| c');
  });

  it('summarises folders', () => {
    expect(folderSummary(['README.md', 'src/a/x.cs', 'src/a/y.cs', 'tests/t.cs'])).toEqual(['(root) (1 files)', 'src/a/ (2 files)', 'tests/ (1 files)']);
  });

  it('detects changed, added and removed files', () => {
    expect([...changedFiles({ a: '1', b: '2', c: '3' }, { a: '1', b: 'X', d: '4' })].sort()).toEqual(['b', 'c', 'd']);
  });
});
