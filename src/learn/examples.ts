// Finds real examples of a concept in the learner's repo by plain text search, for the "In this
// codebase" part of a lesson. No AI involved. Pure.

import { classify, isLowValue } from '../scan/classify';
import type { RepoFile } from '../scan/digest';

export interface Example {
  file: string;
  /** 1-based line of the match. */
  line: number;
  /** 1-based line the snippet starts at. */
  start: number;
  lines: string[];
}

export interface ExampleSearch {
  /** What was searched for, as written. */
  terms: string[];
  /** Files searched. */
  searched: number;
  /** Files with at least one match. */
  matched: number;
  examples: Example[];
  /** Other places it is used, one per file. */
  more: { file: string; line: number; text: string }[];
}

export interface ExampleQuery {
  /** Identifiers, matched as whole words, e.g. "IMediator", "observable". */
  tokens: string[];
  /** Code as written, matched exactly, e.g. `data-bind="`. */
  patterns: string[];
}

export interface ExampleOptions {
  /** Examples to show in full. */
  max?: number;
  /** Other places to list. */
  more?: number;
  /** Which part of the repo a file belongs to, so examples come from different parts. */
  groupOf?: (path: string) => string;
  /** How central each file is; central files make better examples. */
  importance?: Map<string, number>;
}

/** Words too common to mean anything on their own. */
const STOP = new Set(
  'if else for while do new var let const this the and not get set string int bool void return public private class true false null undefined function import export from default async await type value data item list map id name'.split(
    ' ',
  ),
);

const SEARCHED_ROLES = new Set(['code', 'template', 'deploy']);

export function exampleTerms(q: ExampleQuery): { words: string[]; literals: string[] } {
  const words = [...new Set(q.tokens.map((t) => t.trim()))].filter((t) => /^[A-Za-z_$][\w$]*$/.test(t) && t.length >= 2 && !STOP.has(t.toLowerCase()));
  const literals = [...new Set(q.patterns.map((p) => p.trim()))].filter((p) => p.length >= 3);
  return { words, literals };
}

export function searchExamples(files: RepoFile[], q: ExampleQuery, opts: ExampleOptions = {}): ExampleSearch {
  const { words, literals } = exampleTerms(q);
  const terms = [...literals, ...words];
  const searchable = files.filter((f) => SEARCHED_ROLES.has(classify(f.path)));
  const empty: ExampleSearch = { terms, searched: searchable.length, matched: 0, examples: [], more: [] };
  if (terms.length === 0) return empty;

  const wordRe = words.length ? new RegExp(`(^|[^\\w$])(${words.map(escapeRe).join('|')})(?![\\w$])`) : undefined;
  const hits: { file: RepoFile; lines: string[]; line: number; count: number; score: number }[] = [];
  for (const f of searchable) {
    const lines = f.text.split(/\r?\n/);
    let first = -1;
    let firstLiteral = -1;
    let count = 0;
    const seenLiterals = new Set<string>();
    const seenWords = new Set<string>();
    for (let i = 0; i < lines.length && count < 200; i++) {
      const l = lines[i];
      if (l.length > 1000) continue;
      let matched = false;
      for (const p of literals) {
        if (l.includes(p)) {
          seenLiterals.add(p);
          matched = true;
          if (firstLiteral < 0) firstLiteral = i;
        }
      }
      const m = wordRe?.exec(l);
      if (m) {
        seenWords.add(m[2]);
        matched = true;
      }
      if (matched) {
        count++;
        if (first < 0) first = i;
      }
    }
    if (count === 0) continue;
    // A literal pattern is the more specific match, so it makes the better example line.
    const line = (firstLiteral >= 0 ? firstLiteral : first) + 1;
    // Code as written says more than a name that might mean something else.
    const score =
      (isLowValue(f.path) ? -100 : 0) + 4 * seenLiterals.size + 2 * seenWords.size + Math.log2(1 + count) + 0.3 * (opts.importance?.get(f.path) ?? 0);
    hits.push({ file: f, lines, line, count, score });
  }
  hits.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  // One of each kind of file first (a template and the code behind it, say), then the best match
  // from each other part of the repo, then the next best. Tests and samples only when nothing else matches.
  const max = opts.max ?? 3;
  const groupOf = opts.groupOf ?? ((p: string) => p.split('/').slice(0, -1).join('/'));
  const picked: typeof hits = [];
  const groups = new Set<string>();
  const take = (h: (typeof hits)[number]) => {
    picked.push(h);
    groups.add(groupOf(h.file.path));
  };
  const real = hits.filter((h) => !isLowValue(h.file.path));
  const best = real.length ? real : hits;
  const roles = new Set<string>();
  for (const h of best) {
    if (picked.length >= max) break;
    const role = classify(h.file.path);
    if (roles.has(role)) continue;
    roles.add(role);
    take(h);
  }
  for (const h of best) {
    if (picked.length >= max) break;
    if (!picked.includes(h) && !groups.has(groupOf(h.file.path))) take(h);
  }
  for (const h of hits) {
    if (picked.length >= max) break;
    if (!picked.includes(h)) take(h);
  }

  const examples = picked.map((h) => snippet(h.file.path, h.lines, h.line));
  const more = hits
    .filter((h) => !picked.includes(h))
    .slice(0, opts.more ?? 10)
    .map((h) => ({ file: h.file.path, line: h.line, text: h.lines[h.line - 1].trim().slice(0, 160) }));
  return { terms, searched: searchable.length, matched: hits.length, examples, more };
}

/** Two lines before the match and four after, without blank lines at either end. */
function snippet(file: string, lines: string[], line: number): Example {
  let from = Math.max(1, line - 2);
  let to = Math.min(lines.length, line + 4);
  while (from < line && !lines[from - 1].trim()) from++;
  while (to > line && !lines[to - 1].trim()) to--;
  return { file, line, start: from, lines: lines.slice(from - 1, to).map((l) => l.slice(0, 200)) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The examples as prompt text, for lessons that teach with this repo's code. */
export function examplesText(found: ExampleSearch): string {
  if (found.examples.length === 0) return '';
  const blocks = found.examples.map((e) => `${e.file}:${e.line}\n\`\`\`\n${e.lines.map((l, i) => `${e.start + i}| ${l}`).join('\n')}\n\`\`\``);
  const more = found.more.length ? `\nAlso used in: ${found.more.map((m) => `${m.file}:${m.line}`).join(', ')}` : '';
  return `Examples found in this repo (${found.matched} files use it):\n${blocks.join('\n\n')}${more}`;
}
