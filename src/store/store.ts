import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { slug } from '../ai/normalize';
import type { ConceptStatus, Explanation, LearnerProfile, Lesson, RepoMap, Walkthrough } from './types';
import { MAP_VERSION } from './types';

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined,
  ) {}

  get hasWorkspace(): boolean {
    return !!this.workspaceFolder;
  }

  get repoName(): string {
    return this.workspaceFolder?.name ?? 'workspace';
  }

  get root(): vscode.Uri | undefined {
    return this.workspaceFolder?.uri;
  }

  private get repoDir(): vscode.Uri {
    if (!this.workspaceFolder) throw new Error('Open a folder to use codelearn.');
    const key = `${slug(this.workspaceFolder.name)}-${hash(this.workspaceFolder.uri.toString())}`;
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'repos', key);
  }

  private get libraryDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'library');
  }

  // ---- map ----

  async getMap(): Promise<RepoMap | undefined> {
    if (this.cachedMap !== null) return this.cachedMap;
    if (!this.workspaceFolder) return (this.cachedMap = undefined);
    const map = await this.readJson<RepoMap>(vscode.Uri.joinPath(this.repoDir, 'map.json'));
    this.cachedMap = map && map.version === MAP_VERSION ? map : undefined;
    return this.cachedMap;
  }

  async saveMap(map: RepoMap): Promise<void> {
    await this.writeJson(vscode.Uri.joinPath(this.repoDir, 'map.json'), map);
    this.cachedMap = map;
    this.onDidChangeEmitter.fire();
  }

  // ---- lessons ----

  private lessonUri(conceptName: string, depth: string, general: boolean): vscode.Uri {
    return general
      ? vscode.Uri.joinPath(this.libraryDir, `${slug(conceptName)}.${depth}.${this.profileHash()}.json`)
      : vscode.Uri.joinPath(this.repoDir, 'lessons', `${slug(conceptName)}.${depth}.json`);
  }

  getLesson(conceptName: string, depth: string, general: boolean): Promise<Lesson | undefined> {
    return this.readJson<Lesson>(this.lessonUri(conceptName, depth, general));
  }

  saveLesson(lesson: Lesson, general: boolean): Promise<void> {
    return this.writeJson(this.lessonUri(lesson.conceptName, lesson.depth, general), lesson);
  }

  // ---- explanations (keyed by a hash of what was explained) ----

  getExplanation(key: string): Promise<Explanation | undefined> {
    return this.readJson<Explanation>(vscode.Uri.joinPath(this.repoDir, 'explanations', `${hash(key)}.json`));
  }

  saveExplanation(key: string, e: Explanation): Promise<void> {
    return this.writeJson(vscode.Uri.joinPath(this.repoDir, 'explanations', `${hash(key)}.json`), e);
  }

  // ---- walkthroughs ----

  getWalkthrough(id: string): Promise<Walkthrough | undefined> {
    return this.readJson(vscode.Uri.joinPath(this.repoDir, 'walkthroughs', `${slug(id)}.json`));
  }

  saveWalkthrough(w: Walkthrough): Promise<void> {
    return this.writeJson(vscode.Uri.joinPath(this.repoDir, 'walkthroughs', `${slug(w.id)}.json`), w);
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
      await vscode.workspace.fs.delete(this.repoDir, { recursive: true, useTrash: false });
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
