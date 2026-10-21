// Picks and formats the code a focused AI request reads: a flow's files and what they use, an
// area's most important files, or the files that match a question. Pure.

import { covers } from '../learn/places';
import { classify, isLowValue } from './classify';
import { numbered, RepoFile } from './digest';
import { excerpt } from './excerpt';
import { RepoIndex, TOPICS } from './repoIndex';

export interface Source {
  file: string;
  /** Lines prefixed with their 1-based numbers; "…|" where code was left out. */
  code: string;
}

/**
 * The files in `paths` order, within `budget` characters: whole when short, else the parts that
 * explain them (see excerpt). Files that don't exist are skipped.
 */
export function sourcesFor(files: RepoFile[], paths: string[], budget: number, maxLinesEach = 220): Source[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: Source[] = [];
  let used = 0;
  for (const p of [...new Set(paths)]) {
    const f = byPath.get(p);
    if (!f) continue;
    const left = budget - used;
    if (left < 800) break;
    const total = f.text.split(/\r?\n/).length;
    let code = total <= maxLinesEach ? numbered(f.text, total) : excerpt(f.text, maxLinesEach).text;
    if (code.length > left) code = `${code.slice(0, code.lastIndexOf('\n', left - 40))}\n…| (rest of the file not shown)`;
    out.push({ file: p, code });
    used += code.length + p.length + 12;
  }
  return out;
}

/** A flow's files, then the repo code they use directly, up to `max` files. */
export function withImports(seeds: string[], index: RepoIndex, max = 14): string[] {
  const out = [...new Set(seeds)];
  for (const f of seeds) {
    for (const d of index.imports.get(f) ?? []) {
      if (out.length >= max) return out;
      if (!out.includes(d) && classify(d) === 'code' && !isLowValue(d)) out.push(d);
    }
  }
  return out.slice(0, max);
}

/** The files under an area's paths, most important first. */
export function filesUnder(paths: string[], index: RepoIndex, max = 14): string[] {
  return index.ranked.filter((p) => paths.some((x) => covers(x, p))).slice(0, max);
}

const STOP = new Set(
  'how does what the where when which work works working is are was why this that with from for and app application code get set use used using into about there their them then than does doing done its it\'s our your you can could should would happen happens handled handle file files repo repository part'.split(
    ' ',
  ),
);

/** Files that match a question, by name and content; the matching cross-cutting topic's files first. */
export function filesForQuestion(question: string, files: RepoFile[], index: RepoIndex, max = 10): string[] {
  const words = [...new Set((question.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)))];
  const out: string[] = [];
  for (const t of TOPICS) {
    if (t.path.test(question)) {
      const hits = index.topics.find((x) => x.id === t.id)?.hits ?? [];
      for (const h of hits.slice(0, 4)) if (!out.includes(h.path)) out.push(h.path);
    }
  }
  if (words.length) {
    const scored: { path: string; score: number }[] = [];
    for (const f of files) {
      const role = classify(f.path);
      if ((role !== 'code' && role !== 'template') || out.includes(f.path)) continue;
      const path = f.path.toLowerCase();
      const text = f.text.toLowerCase();
      let s = 0;
      for (const w of words) {
        const stem = w.length > 5 ? w.slice(0, -1) : w;
        if (path.includes(stem)) s += 3;
        let n = 0;
        for (let i = text.indexOf(stem); i >= 0 && n < 10; i = text.indexOf(stem, i + stem.length)) n++;
        s += 0.3 * n;
      }
      if (s === 0) continue;
      s += 0.2 * (index.score.get(f.path) ?? 0) - (isLowValue(f.path) ? 5 : 0);
      scored.push({ path: f.path, score: s });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    for (const x of scored) {
      if (out.length >= max) break;
      out.push(x.path);
    }
  }
  return out.slice(0, max);
}
