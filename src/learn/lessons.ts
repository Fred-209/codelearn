import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { checkQuestion, comparison, list, obj, slug, str, strs } from '../ai/normalize';
import { lessonPrompt } from '../ai/prompts';
import type { Services } from '../services';
import { hash } from '../store/store';
import type { Concept, Depth, Lesson } from '../store/types';
import { readText } from './files';

/** Kinds whose lessons don't depend on the repo, so they're saved once and shared by every repo. */
const GENERAL_KINDS = new Set(['language', 'library', 'pattern', 'tooling']);

export function isGeneral(c: Concept): boolean {
  return GENERAL_KINDS.has(c.kind);
}

/** The key general lessons are saved under, e.g. "C# LINQ Where" rather than just "Where". */
export function lessonKey(c: Concept): string {
  return isGeneral(c) ? c.searchQuery || c.name : c.name;
}

export class Lessons {
  constructor(private readonly s: Services) {}

  /** Finds a concept by id or name; anything unknown (e.g. a prerequisite) becomes a stub concept. */
  async resolve(ref: string): Promise<Concept> {
    const map = await this.s.store.getMap();
    const id = slug(ref);
    const found = map?.concepts.find((c) => c.id === ref || c.id === id || slug(c.name) === id);
    if (found) return found;
    return {
      id,
      name: ref,
      kind: 'pattern',
      summary: '',
      hover: '',
      match: [],
      prereqs: [],
      usage: '',
      citations: [],
      searchQuery: ref,
    };
  }

  async cached(concept: Concept, depth: Depth): Promise<Lesson | undefined> {
    return this.s.store.getLesson(lessonKey(concept), depth, isGeneral(concept));
  }

  async generate(concept: Concept, depth: Depth, token?: vscode.CancellationToken, feedback?: string): Promise<Lesson> {
    const context = await this.repoContext(concept);
    const prompt = lessonPrompt(
      { name: lessonKey(concept), kind: concept.kind, summary: concept.summary },
      depth,
      this.s.store.getProfile(),
      context,
      feedback,
    );
    const { value, model } = await completeJson(
      this.s.ai,
      { slot: feedback ? 'deep' : 'standard', ...prompt, justification: 'codelearn writes lessons about the code you are reading.' },
      (v) => {
        const o = obj(v);
        const body = str(o.body);
        if (!body) throw new Error('The AI reply had no lesson text.');
        return {
          body,
          comparisons: list(o.comparisons, comparison, 3),
          pitfalls: strs(o.pitfalls).slice(0, 4),
          check: checkQuestion(o.check),
        };
      },
      token,
    );
    const lesson: Lesson = {
      conceptId: concept.id,
      conceptName: lessonKey(concept),
      depth,
      body: value.body,
      comparisons: value.comparisons,
      usage: concept.usage,
      citations: concept.citations,
      pitfalls: value.pitfalls,
      check: value.check,
      generatedAt: new Date().toISOString(),
      model,
      sourceHash: hash(context),
    };
    await this.s.store.saveLesson(lesson, isGeneral(concept));
    return lesson;
  }

  /**
   * Repo-specific concepts (architecture, domain) are taught with this repo's code.
   * General ones get no repo code, so their lessons can be shared across repos.
   */
  private async repoContext(concept: Concept): Promise<string> {
    if (isGeneral(concept)) return '';
    const root = this.s.store.root;
    const map = await this.s.store.getMap();
    const parts: string[] = [];
    if (map) parts.push(`Repository overview: ${map.overview}`);
    if (concept.usage) parts.push(`How this repo uses it: ${concept.usage}`);
    if (root) {
      for (const c of concept.citations.slice(0, 3)) {
        const text = await readText(root, c.file);
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        const from = Math.max(0, c.line - 6);
        const snippet = lines
          .slice(from, from + 14)
          .map((l, i) => `${from + i + 1}| ${l}`)
          .join('\n');
        parts.push(`${c.file}:\n\`\`\`\n${snippet}\n\`\`\``);
      }
    }
    return parts.join('\n\n');
  }
}
