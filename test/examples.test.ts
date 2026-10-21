import { describe, expect, it } from 'vitest';
import { examplesText, searchExamples } from '../src/learn/examples';
import { covers, placesFor } from '../src/learn/places';
import type { RepoFile } from '../src/scan/digest';
import type { RepoMap } from '../src/store/types';

const file = (path: string, text: string): RepoFile => ({ path, text, size: text.length });

const files = [
  file('src/components/signin/signin.html', '<form>\n  <label>User</label>\n  <input data-bind="textInput: username" />\n  <button data-bind="click: signIn">Sign in</button>\n</form>\n'),
  file('src/components/signin/signin.ts', 'export class SignIn {\n  public readonly username = ko.observable("");\n  public readonly ready = ko.computed(() => !!this.username());\n}\n'),
  file('src/components/profile/profile.html', '<div data-bind="text: name"></div>\n'),
  file('src/components/profile/profile.ts', 'export class Profile {\n  public name = ko.observable("");\n}\n'),
  file('src/services/usersService.ts', 'export class UsersService {}\n'),
  file('tests/signin.spec.ts', 'const vm = { username: ko.observable("x") };\n'),
  file('README.md', 'Uses data-bind="..." everywhere.\n'),
];

describe('searchExamples', () => {
  const found = searchExamples(files, { tokens: ['observable', 'computed'], patterns: ['data-bind="'] }, { max: 3 });

  it('searches code and templates, not docs, and counts the files that match', () => {
    expect(found.searched).toBe(6);
    expect(found.matched).toBe(5);
    expect(found.terms).toEqual(['data-bind="', 'observable', 'computed']);
  });

  it('shows a template and the code behind it, then another part of the repo, real code before tests', () => {
    const where = found.examples.map((e) => e.file);
    expect(where).toEqual(['src/components/signin/signin.html', 'src/components/signin/signin.ts', 'src/components/profile/profile.html']);
    expect(found.more.map((m) => m.file)).toContain('tests/signin.spec.ts');
  });

  it('ranks code as written above a name that matches', () => {
    const one = searchExamples(files, { tokens: ['observable'], patterns: ['data-bind="'] }, { max: 1 });
    expect(one.examples[0].file).toBe('src/components/signin/signin.html');
  });

  it('cuts a snippet around the match with real line numbers', () => {
    const html = searchExamples(files, { tokens: [], patterns: ['data-bind="click'] });
    expect(html.examples[0]).toEqual({
      file: 'src/components/signin/signin.html',
      line: 4,
      start: 2,
      lines: ['  <label>User</label>', '  <input data-bind="textInput: username" />', '  <button data-bind="click: signIn">Sign in</button>', '</form>'],
    });
    expect(examplesText(html)).toContain('4|   <button data-bind="click: signIn">Sign in</button>');
  });

  it('ignores words too common to search for', () => {
    expect(searchExamples(files, { tokens: ['this', 'get', 'x'], patterns: ['ab'] }).terms).toEqual([]);
  });
});

describe('places', () => {
  const map: Pick<RepoMap, 'areas' | 'flows' | 'architecture'> = {
    areas: [
      { id: 'components', name: 'Widgets', summary: '', paths: ['src/components'] },
      { id: 'signin', name: 'Sign-in widgets', summary: '', paths: ['src/components/signin/'] },
    ],
    flows: [{ id: 'sign-in', name: 'Signing in', summary: '', files: ['src/services/usersService.ts'], steps: [{ file: 'src/components/signin/signin.ts', line: 2, title: 'Bind', body: '' }] }],
    architecture: {
      summary: '',
      parts: [
        { id: 'runtime', name: 'Runtime', summary: '', paths: ['src/**/*.ts'] },
        { id: 'aad', name: 'Azure AD B2C', summary: '', paths: [], external: true },
      ],
      links: [],
    },
  };

  it('matches folders, files and globs', () => {
    expect(covers('src/components', 'src/components/signin/signin.ts')).toBe(true);
    expect(covers('src/comp', 'src/components/signin/signin.ts')).toBe(false);
    expect(covers('src/**/*.ts', 'src/components/signin/signin.ts')).toBe(true);
    expect(covers('src/*.ts', 'src/components/signin/signin.ts')).toBe(false);
  });

  it('lists the part, the most specific area first, and the flows that step through the file', () => {
    expect(placesFor(map, 'src/components/signin/signin.ts')).toEqual([
      { type: 'part', id: 'runtime', name: 'Runtime' },
      { type: 'area', id: 'signin', name: 'Sign-in widgets' },
      { type: 'area', id: 'components', name: 'Widgets' },
      { type: 'flow', id: 'sign-in', name: 'Signing in' },
    ]);
  });
});
