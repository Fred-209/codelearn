import * as vscode from 'vscode';
import { completeJson } from '../ai/provider';
import { checkQuestion, comparison, list, obj, patterns, slug, str, strs } from '../ai/normalize';
import { lessonPrompt } from '../ai/prompts';
import type { Services } from '../services';
import { hash } from '../store/store';
import type { Concept, Depth, Lesson } from '../store/types';
import { checkedDocs } from './docLinks';
import { ExampleSearch, examplesText, searchExamples } from './examples';
import { readText } from './files';
import { matchTokens } from './matcher';

/** Kinds whose lessons don't depend on the repo, so they're saved once and shared by every repo. */
const GENERAL_KINDS = new Set(['language', 'library', 'pattern', 'tooling']);

/** Lookups for a lesson on a repo-specific concept. General lessons get none: they're shared. */
const LESSON_LOOKUPS = 6;

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

  /**
   * Real uses of the concept in this repo, found by text search: no AI. Uses the concept's
   * identifiers and code patterns from the map, plus the patterns its lesson suggested.
   */
  async examples(concept: Concept, lesson?: Lesson): Promise<ExampleSearch> {
    const snap = await this.s.files.get();
    const index = this.s.files.index(snap);
    return searchExamples(
      snap.files,
      { tokens: concept.match.flatMap(matchTokens), patterns: [...(concept.patterns ?? []), ...(lesson?.patterns ?? [])] },
      { groupOf: index.groupOf, importance: index.score },
    );
  }

  async generate(concept: Concept, depth: Depth, token?: vscode.CancellationToken, feedback?: string): Promise<Lesson> {
    const general = isGeneral(concept);
    const repo = general ? '' : await this.repoContext(concept);
    const prompt = lessonPrompt({ name: lessonKey(concept), kind: concept.kind, summary: concept.summary }, depth, this.s.store.getProfile(), {
      general,
      repo,
      docsSite: concept.docsSite,
      feedback,
    });
    const { value, model } = await completeJson(
      this.s.ai,
      {
        slot: feedback ? 'deep' : 'standard',
        ...prompt,
        justification: 'codelearn writes lessons about the code you are reading.',
        purpose: `${feedback ? 'rewrite lesson' : 'lesson'}: ${concept.name} (${depth})`,
        lookups: general ? undefined : await this.s.files.lookups(LESSON_LOOKUPS),
      },
      (v) => {
        const o = obj(v);
        const body = str(o.body);
        if (!body) throw new Error('The AI reply had no lesson text.');
        return {
          body,
          comparisons: list(o.comparisons, comparison, 3),
          pitfalls: strs(o.pitfalls).slice(0, 4),
          check: checkQuestion(o.check),
          patterns: patterns(o.patterns),
          docsSite: str(o.docsSite),
          docs: Array.isArray(o.docs) ? (o.docs as { title?: unknown; url?: unknown }[]) : [],
        };
      },
      token,
    );
    const check = vscode.workspace.getConfiguration('codelearn').get<boolean>('lessons.checkDocLinks', true);
    const docs = general ? await checkedDocs(value.docs, [concept.docsSite, value.docsSite], check, globalThis.fetch) : [];
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
      sourceHash: hash(repo),
      ...(value.patterns.length ? { patterns: value.patterns } : {}),
      ...(docs.length ? { docs } : {}),
    };
    await this.s.store.saveLesson(lesson, general);
    return lesson;
  }

  /** Repo-specific concepts (architecture, domain) are taught with this repo's code. */
  private async repoContext(concept: Concept): Promise<string> {
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
    const found = examplesText(await this.examples(concept));
    if (found) parts.push(found);
    return parts.join('\n\n');
  }
}
