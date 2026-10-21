import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { slug } from '../ai/normalize';
import { RepoIdentity, resolveRepoIdentity } from './gitIdentity';
import { migrateExplanation, migrateLesson, migrateMap, migrateWalkthrough } from './migrate';
import type { ConceptStatus, Explanation, LearnerProfile, Lesson, RepoMap, Walkthrough } from './types';

export function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

const PROFILE_KEY = 'codelearn.profile';
const STATUS_KEY = 'codelearn.conceptStatus';
const VIEW_KEY = 'codelearn.walkthroughView';

/**
 * Everything codelearn saves, in VS Code's private storage for this extension:
 *
 *   <globalStorage>/repos/<repoKey>/map.json
 *   <globalStorage>/repos/<repoKey>/lessons/<concept>.<depth>.json      (repo-specific concepts)
 *   <globalStorage>/repos/<repoKey>/explanations/<hash>.json
 *   <globalStorage>/repos/<repoKey>/walkthroughs/<id>.json
 *   <globalStorage>/library/<concept-name>.<depth>.<profile>.json        (general concepts, shared by all repos)
 *
 * Learner profile and concept status live in globalState, so they follow the
 * learner across repos. Nothing is written into the workspace.
 */
export class Store {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private cachedMap: RepoMap | undefined | null = null; // null = not loaded yet
  private dirPromise: Promise<vscode.Uri> | undefined;
  private identityName: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined,
  ) {}

  get hasWorkspace(): boolean {
    return !!this.workspaceFolder;
  }

  get repoName(): string {
    return this.identityName ?? this.workspaceFolder?.name ?? 'workspace';
  }

  get root(): vscode.Uri | undefined {
    return this.workspaceFolder?.uri;
  }

  /** Which repo this is, and its current branch and commit. Read fresh each time. */
  async gitState(): Promise<RepoIdentity | undefined> {
    const folder = this.workspaceFolder;
    if (!folder) return undefined;
    if (folder.uri.scheme !== 'file') return { key: `folder:${folder.uri.toString()}`, name: folder.name };
    return resolveRepoIdentity(folder.uri.fsPath, readTextFile, folder.name);
  }

  /**
   * One folder per repository, not per checkout: every git worktree and clone of the same
   * repo (same origin URL, or the same .git folder) shares its map, lessons and walkthroughs.
   */
  private repoDir(): Promise<vscode.Uri> {
    return (this.dirPromise ??= this.resolveRepoDir());
  }

  private async resolveRepoDir(): Promise<vscode.Uri> {
    const folder = this.workspaceFolder;
    if (!folder) throw new Error('Open a folder to use codelearn.');
    const id = (await this.gitState())!;
    this.identityName = id.name;
    const repos = vscode.Uri.joinPath(this.context.globalStorageUri, 'repos');
    const dir = vscode.Uri.joinPath(repos, `${slug(id.name)}-${hash(id.key)}`);
    // Before 0.1.x settled, data was keyed by folder path. Move it over once.
    const legacy = vscode.Uri.joinPath(repos, `${slug(folder.name)}-${hash(folder.uri.toString())}`);
    if (legacy.toString() !== dir.toString() && (await exists(legacy)) && !(await exists(dir))) {
      try {
        await vscode.workspace.fs.rename(legacy, dir);
      } catch {
        return legacy;
      }
    }
    return dir;
  }

  private get libraryDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'library');
  }

  // ---- map ----

  async getMap(): Promise<RepoMap | undefined> {
    if (this.cachedMap !== null) return this.cachedMap;
    if (!this.workspaceFolder) return (this.cachedMap = undefined);
    // Older maps are upgraded, never discarded: a new codelearn release shouldn't cost a rebuild.
    this.cachedMap = migrateMap(await this.readJson(vscode.Uri.joinPath(await this.repoDir(), 'map.json')));
    return this.cachedMap;
  }

  async saveMap(map: RepoMap): Promise<void> {
    await this.writeJson(vscode.Uri.joinPath(await this.repoDir(), 'map.json'), map);
    this.cachedMap = map;
    this.onDidChangeEmitter.fire();
  }

  // ---- lessons ----

  private async lessonUri(conceptName: string, depth: string, general: boolean): Promise<vscode.Uri> {
    return general
      ? vscode.Uri.joinPath(this.libraryDir, `${slug(conceptName)}.${depth}.${this.profileHash()}.json`)
      : vscode.Uri.joinPath(await this.repoDir(), 'lessons', `${slug(conceptName)}.${depth}.json`);
  }

  async getLesson(conceptName: string, depth: string, general: boolean): Promise<Lesson | undefined> {
    return migrateLesson(await this.readJson(await this.lessonUri(conceptName, depth, general)));
  }

  async saveLesson(lesson: Lesson, general: boolean): Promise<void> {
    return this.writeJson(await this.lessonUri(lesson.conceptName, lesson.depth, general), lesson);
  }

  // ---- explanations (keyed by a hash of what was explained) ----

  async getExplanation(key: string): Promise<Explanation | undefined> {
    return migrateExplanation(await this.readJson(vscode.Uri.joinPath(await this.repoDir(), 'explanations', `${hash(key)}.json`)));
  }

  async saveExplanation(key: string, e: Explanation): Promise<void> {
    return this.writeJson(vscode.Uri.joinPath(await this.repoDir(), 'explanations', `${hash(key)}.json`), e);
  }

  // ---- walkthroughs ----

  async getWalkthrough(id: string): Promise<Walkthrough | undefined> {
    return migrateWalkthrough(await this.readJson(vscode.Uri.joinPath(await this.repoDir(), 'walkthroughs', `${slug(id)}.json`)));
  }

  async saveWalkthrough(w: Walkthrough): Promise<void> {
    return this.writeJson(vscode.Uri.joinPath(await this.repoDir(), 'walkthroughs', `${slug(w.id)}.json`), w);
  }

  // ---- learner ----

  getProfile(): LearnerProfile | undefined {
    return this.context.globalState.get<LearnerProfile>(PROFILE_KEY);
  }

  async saveProfile(p: LearnerProfile): Promise<void> {
    await this.context.globalState.update(PROFILE_KEY, p);
    this.onDidChangeEmitter.fire();
  }

  /** Lessons are written for a profile; a changed profile gets fresh general lessons. */
  profileHash(): string {
    const p = this.getProfile();
    return p ? hash(`${p.experience}|${[...p.known].sort().join(',')}`).slice(0, 8) : 'anon';
  }

  getStatus(conceptName: string): ConceptStatus {
    const all = this.context.globalState.get<Record<string, ConceptStatus>>(STATUS_KEY, {});
    return all[slug(conceptName)] ?? 'new';
  }

  async setStatus(conceptName: string, status: ConceptStatus): Promise<void> {
    const all = { ...this.context.globalState.get<Record<string, ConceptStatus>>(STATUS_KEY, {}) };
    all[slug(conceptName)] = status;
    await this.context.globalState.update(STATUS_KEY, all);
    this.onDidChangeEmitter.fire();
  }

  getWalkthroughView(): 'inline' | 'panel' {
    return (
      this.context.globalState.get<'inline' | 'panel'>(VIEW_KEY) ??
      vscode.workspace.getConfiguration('codelearn').get<'inline' | 'panel'>('walkthrough.defaultView', 'inline')
    );
  }

  setWalkthroughView(view: 'inline' | 'panel'): Thenable<void> {
    return this.context.globalState.update(VIEW_KEY, view);
  }

  // ---- housekeeping ----

  async clearRepo(): Promise<void> {
    try {
      await vscode.workspace.fs.delete(await this.repoDir(), { recursive: true, useTrash: false });
    } catch {
      // nothing saved yet
    }
    this.cachedMap = undefined;
    this.onDidChangeEmitter.fire();
  }

  private async readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** For reading git's own files (.git, HEAD, config). Undefined for missing files and folders. */
async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
