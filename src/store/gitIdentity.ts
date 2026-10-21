// Works out which repository a folder belongs to, so every git worktree and clone of the
// same repo shares one map. Pure apart from the file reader it is given, so it can be tested.

import * as path from 'path';

export interface RepoIdentity {
  /** Stable across worktrees: the origin URL if there is one, else the shared .git folder. */
  key: string;
  /** Display name, e.g. "payments-api". */
  name: string;
  /** Checked-out branch and commit, when they can be read. */
  branch?: string;
  commit?: string;
}

/** Reads a text file, or returns undefined if it doesn't exist. */
export type ReadText = (file: string) => Promise<string | undefined>;

/** A worktree's `.git` is a file: "gitdir: /path/to/main/.git/worktrees/feature-x". */
export function parseGitFile(text: string): string | undefined {
  return /^gitdir:\s*(.+)$/m.exec(text)?.[1].trim();
}

/** The url of [remote "origin"] (or the first remote) in a git config file. */
export function remoteUrl(config: string): string | undefined {
  let section = '';
  const urls: Record<string, string> = {};
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      section = '';
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (section && url && !urls[section]) urls[section] = url[1].trim();
  }
  return urls.origin ?? Object.values(urls)[0];
}

/**
 * "git@github.com:Org/Repo.git", "https://user:token@github.com/org/repo" -> "github.com/org/repo".
 * Credentials are dropped, so they never reach a folder name or the log.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(u); // git@host:org/repo
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '');
  return u.toLowerCase();
}

export async function resolveRepoIdentity(folder: string, read: ReadText, folderName = path.basename(folder)): Promise<RepoIdentity> {
  const dotGit = path.join(folder, '.git');
  let gitDir = dotGit;
  let commonDir = dotGit;

  const asFile = await read(dotGit);
  const pointer = asFile && parseGitFile(asFile);
  if (pointer) {
    gitDir = path.resolve(folder, pointer);
    const common = (await read(path.join(gitDir, 'commondir')))?.trim();
    commonDir = common ? path.resolve(gitDir, common) : gitDir;
  }

  const config = await read(path.join(commonDir, 'config'));
  if (config === undefined && !pointer) {
    // Not a git repo (or not readable): fall back to the folder itself.
    return { key: `folder:${folder}`, name: folderName };
  }

  const head = (await read(path.join(gitDir, 'HEAD')))?.trim();
  const branch = head && /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  let commit = head && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  if (branch) {
    commit =
      (await read(path.join(commonDir, 'refs', 'heads', branch)))?.trim() ??
      packedRef((await read(path.join(commonDir, 'packed-refs'))) ?? '', `refs/heads/${branch}`);
  }

  const remote = config && remoteUrl(config);
  if (remote) {
    const normalized = normalizeRemote(remote);
    return { key: `remote:${normalized}`, name: normalized.split('/').pop() || folderName, branch, commit };
  }
  // A local-only repo: worktrees share the main .git folder, so key on that.
  const mainFolder = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { key: `git:${commonDir}`, name: path.basename(mainFolder) || folderName, branch, commit };
}

function packedRef(packed: string, ref: string): string | undefined {
  for (const line of packed.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return undefined;
}
