import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { normalizeRemote, parseGitFile, remoteUrl, resolveRepoIdentity } from '../src/store/gitIdentity';
import { migrateLesson, migrateMap, migrateWalkthrough } from '../src/store/migrate';
import { MAP_VERSION } from '../src/store/types';

const SHA = 'a'.repeat(40);
const fakeFs = (files: Record<string, string>) => async (f: string) => files[path.normalize(f)];

describe('repo identity', () => {
  it('normalizes remotes and drops credentials', () => {
    expect(normalizeRemote('git@github.com:Org/Repo.git')).toBe('github.com/org/repo');
    expect(normalizeRemote('https://user:token@github.com/org/repo/')).toBe('github.com/org/repo');
    expect(normalizeRemote('ssh://git@ssh.dev.azure.com/v3/org/proj/repo')).toBe('ssh.dev.azure.com/v3/org/proj/repo');
  });

  it('reads origin, else the first remote', () => {
    expect(remoteUrl('[core]\n\tbare = false\n[remote "upstream"]\n\turl = u\n[remote "origin"]\n\turl = o\n')).toBe('o');
    expect(remoteUrl('[remote "upstream"]\n\turl = u\n')).toBe('u');
    expect(remoteUrl('[core]\n')).toBeUndefined();
  });

  it('parses a worktree .git file', () => {
    expect(parseGitFile('gitdir: /home/fred/payments/.git/worktrees/feature-x\n')).toBe('/home/fred/payments/.git/worktrees/feature-x');
  });

  it('gives the main checkout and its worktrees the same key', async () => {
    const files = {
      '/w/payments/.git/config': '[remote "origin"]\n\turl = git@github.com:acme/payments.git\n',
      '/w/payments/.git/HEAD': 'ref: refs/heads/main\n',
      '/w/payments/.git/refs/heads/main': `${SHA}\n`,
      '/w/feature-x/.git': 'gitdir: /w/payments/.git/worktrees/feature-x\n',
      '/w/payments/.git/worktrees/feature-x/commondir': '../..\n',
      '/w/payments/.git/worktrees/feature-x/HEAD': 'ref: refs/heads/feature/x\n',
      '/w/payments/.git/packed-refs': `# pack-refs\n${'b'.repeat(40)} refs/heads/feature/x\n`,
    };
    const main = await resolveRepoIdentity('/w/payments', fakeFs(files));
    const wt = await resolveRepoIdentity('/w/feature-x', fakeFs(files));
    expect(main.key).toBe('remote:github.com/acme/payments');
    expect(wt.key).toBe(main.key);
    expect(wt.name).toBe('payments');
    expect(main).toMatchObject({ branch: 'main', commit: SHA });
    expect(wt).toMatchObject({ branch: 'feature/x', commit: 'b'.repeat(40) });
  });

  it('keys a local-only repo on its shared .git folder', async () => {
    const files = {
      '/w/tool/.git/config': '[core]\n',
      '/w/tool/.git/HEAD': `${SHA}\n`,
      '/w/tool-wt/.git': 'gitdir: /w/tool/.git/worktrees/tool-wt',
      '/w/tool/.git/worktrees/tool-wt/commondir': '../..',
    };
    const main = await resolveRepoIdentity('/w/tool', fakeFs(files));
    expect(main).toMatchObject({ key: `git:${path.normalize('/w/tool/.git')}`, name: 'tool', commit: SHA });
    expect((await resolveRepoIdentity('/w/tool-wt', fakeFs(files))).key).toBe(main.key);
  });

  it('falls back to the folder outside git', async () => {
    expect(await resolveRepoIdentity('/w/notes', fakeFs({}))).toEqual({ key: 'folder:/w/notes', name: 'notes' });
  });
});

describe('migrating saved data', () => {
  it('loads a map saved by codelearn 0.1 (v1) without a rebuild', () => {
    const v1 = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/saved/map-v1.json'), 'utf8'));
    const map = migrateMap(v1)!;
    expect(map.version).toBe(MAP_VERSION);
    expect(map.concepts[0]).toMatchObject({ id: 'linq', hover: 'LINQ filters and transforms collections.' });
    expect(map.fileHashes['src/GetActivePaymentsHandler.cs']).toBe('0123456789abcdef');
    expect(map.builtFrom).toBeUndefined();
  });

  it('fills in anything missing instead of failing', () => {
    const map = migrateMap({ version: 1, overview: 'x', concepts: [{ id: 'a', name: 'A', kind: 'pattern' }] })!;
    expect(map.areas).toEqual([]);
    expect(map.concepts[0]).toMatchObject({ match: [], prereqs: [], citations: [], hover: '' });
  });

  it('reads a map from a newer codelearn as best it can', () => {
    expect(migrateMap({ version: MAP_VERSION + 5, overview: 'x', concepts: [], futureField: 1 })?.overview).toBe('x');
  });

  it('rejects things that are not saved data', () => {
    expect(migrateMap('nope')).toBeUndefined();
    expect(migrateLesson({})).toBeUndefined();
    expect(migrateWalkthrough({ steps: [] })).toBeUndefined();
  });

  it('fills lesson defaults', () => {
    expect(migrateLesson({ body: 'x' })).toMatchObject({ comparisons: [], pitfalls: [], citations: [] });
  });
});
