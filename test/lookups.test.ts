import { describe, expect, it } from 'vitest';
import { RepoLookup } from '../src/ai/lookups';
import type { RepoFile } from '../src/scan/digest';

const file = (path: string, text: string): RepoFile => ({ path, text, size: text.length });

const repo = new RepoLookup([
  file(
    'src/services/usersService.ts',
    'export class UsersService {\n  public async signIn(user: string, password: string): Promise<void> {\n    await this.client.post("/identity", { user });\n  }\n}\n',
  ),
  file('src/components/signin/signin.ts', 'import { UsersService } from "../../services/usersService";\nexport class SignIn {\n  constructor(private readonly users: UsersService) {}\n  submit() { return this.users.signIn(this.name, this.pw); }\n}\n'),
  file('src/components/signin/signin.html', '<form data-bind="submit: submit">\n  <input data-bind="textInput: name" />\n</form>\n'),
  file('src/config.ts', 'export const settings = { "ClientSecret": "x9y8z7w6v5u4" };\n'),
  file('tests/usersService.spec.ts', 'describe("UsersService", () => { new UsersService(); });\n'),
]);

describe('RepoLookup', () => {
  it('searches literally and case-insensitively, real code before tests', () => {
    const out = repo.search('usersservice');
    expect(out.split('\n')[0]).toBe('4 matching lines in 3 files:');
    expect(out.indexOf('src/services/usersService.ts:1')).toBeLessThan(out.indexOf('tests/usersService.spec.ts:1'));
    expect(repo.search('data-bind="text', false, 'src/components')).toContain('src/components/signin/signin.html:2');
    expect(repo.search('nothing-like-this')).toBe('No matches for "nothing-like-this".');
    expect(repo.search('(', true)).toMatch(/^Not a valid regular expression/);
  });

  it('reads numbered lines and suggests a path when one is wrong', () => {
    expect(repo.readLines('./src/services/usersService.ts', 2, 3)).toBe(
      'src/services/usersService.ts, lines 2-3 of 6:\n2|   public async signIn(user: string, password: string): Promise<void> {\n3|     await this.client.post("/identity", { user });',
    );
    expect(repo.readLines('usersService.ts')).toContain('src/services/usersService.ts, lines 1-6');
    expect(repo.readLines('src/nope.ts')).toBe('No file "src/nope.ts" among the files codelearn reads.');
  });

  it('lists a folder', () => {
    expect(repo.listFolder('src')).toBe('src:\ncomponents/ (2 files)\nservices/ (1 files)\nconfig.ts (2 lines)');
  });

  it('finds definitions and uses', () => {
    const out = repo.findSymbol('signIn');
    expect(out).toContain('Defined at:\nsrc/services/usersService.ts:2:');
    expect(out).toContain('src/components/signin/signin.ts:4:');
    expect(repo.findSymbol('ko')).toContain("isn't in the files codelearn reads");
  });

  it('masks secret-looking values in what it returns', () => {
    expect(repo.run('read_lines', { file: 'src/config.ts' })).toContain('"ClientSecret": "«redacted»"');
    expect(repo.run('search', { query: 'ClientSecret' })).not.toContain('x9y8z7w6v5u4');
  });

  it('turns bad input into a message instead of throwing', () => {
    expect(repo.run('delete_everything', {})).toMatch(/^Unknown lookup/);
    expect(repo.run('read_lines', null)).toMatch(/No file ""/);
  });
});
