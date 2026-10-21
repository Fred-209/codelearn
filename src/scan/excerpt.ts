// Shows the parts of a source file that explain it, within a line budget: no import blocks or
// licence headers, every line down to the deepest nesting level that fits, and the start of
// each deeper block. Pure.

export interface Excerpt {
  /** Numbered lines ("12| code"), with "…|" lines where code was left out. */
  text: string;
  /** Code lines shown. */
  shown: number;
  /** Code lines in the file, imports and blank lines not counted. */
  total: number;
  /** True when some code was left out. */
  cut: boolean;
}

export const IMPORT_LINE =
  /^\s*(import\s|import\{|export\s+(\*|\{[^}]*\}?)\s*(as\s+\w+\s+)?from\s|export\s+\{|from\s+[\w.]+\s+import\s|using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>, ]+)?\s*;|global\s+using\s|#include\s|(const|let|var)\s+[\w{}\s,]+=\s*require\(|require\(|package\s+[\w.]+;?\s*$|use\s+[\w:\\{}, *]+;|extern\s+crate\s|['"]use (strict|client|server)['"];?\s*$|#!)/;
const LICENCE = /licen[cs]e|copyright|spdx|all rights reserved/i;
const CLOSER = /^\s*[}\])]+[;,)]*\s*$/;
const OPENER = /^\s*[{[(]\s*$/;

/** Removes import blocks (including multi-line ones) and a licence header. Keeps original line numbers. */
export function codeLines(text: string): { line: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  let i = 0;

  // A comment block at the very top that mentions a licence.
  const head = leadingComment(lines);
  if (head > 0 && LICENCE.test(lines.slice(0, head).join('\n'))) i = head;

  let depth = 0; // open brackets inside a multi-line import
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (depth > 0) {
      depth += balance(l);
      continue;
    }
    if (IMPORT_LINE.test(l)) {
      depth = Math.max(0, balance(l));
      continue;
    }
    out.push({ line: i + 1, text: l });
  }
  // Collapse runs of blank lines, and trim them at the ends.
  const squeezed = out.filter((l, k) => l.text.trim() || (k > 0 && out[k - 1].text.trim()));
  while (squeezed.length && !squeezed[0].text.trim()) squeezed.shift();
  while (squeezed.length && !squeezed[squeezed.length - 1].text.trim()) squeezed.pop();
  return squeezed;
}

/**
 * The file within `maxLines` code lines. Short files come back whole (minus imports). Longer ones
 * keep every line down to the deepest indentation level that fits in about 60% of the budget
 * (signatures, fields, top-level statements), and share the rest among the deeper blocks, each
 * showing its first lines.
 */
export function excerpt(text: string, maxLines: number): Excerpt {
  const lines = codeLines(text);
  const total = lines.filter((l) => l.text.trim()).length;
  if (lines.length <= maxLines) {
    return { text: lines.map(fmt).join('\n'), shown: total, total, cut: false };
  }

  const code = lines.filter((l) => l.text.trim());
  const indents = [...new Set(code.map((l) => indentOf(l.text)))].sort((a, b) => a - b);
  const level = new Map(indents.map((n, k) => [n, k]));
  const levelOf = (l: { text: string }) => level.get(indentOf(l.text)) ?? 0;

  // The deepest level whose lines (minus lone brackets) fit in 60% of the budget.
  const structural = (d: number) => code.filter((l) => levelOf(l) <= d && !CLOSER.test(l.text) && !OPENER.test(l.text));
  let depth = 0;
  for (let d = 0; d < indents.length; d++) {
    if (structural(d).length <= maxLines * 0.6) depth = d;
    else break;
  }
  const keep = structural(depth);
  if (keep.length >= maxLines) {
    const shown = keep.slice(0, maxLines);
    return { text: [...shown.map(fmt), '…| (rest of the file not shown)'].join('\n'), shown: shown.length, total, cut: true };
  }

  // Runs of deeper lines between the kept ones (a lone bracket also ends a run).
  const kept = new Set(keep);
  const runs: Line[][] = [];
  let run: Line[] = [];
  for (const l of code) {
    if (kept.has(l) || levelOf(l) <= depth) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(l);
    }
  }
  if (run.length) runs.push(run);

  // Share the spare lines out, earlier blocks first when there aren't enough to go round.
  const spare = maxLines - keep.length;
  const each = runs.length ? Math.max(2, Math.floor(spare / runs.length)) : 0;
  let left = spare;
  const startOf = new Map<Line, { run: Line[]; n: number }>();
  for (const r of runs) {
    const n = Math.min(r.length, each, left);
    startOf.set(r[0], { run: r, n });
    left -= n;
  }

  const out: string[] = [];
  let shown = keep.length;
  for (const l of code) {
    if (kept.has(l)) {
      out.push(fmt(l));
      continue;
    }
    const start = startOf.get(l);
    if (!start) continue; // inside a run already handled, or a lone bracket
    for (const x of start.run.slice(0, start.n)) out.push(fmt(x));
    shown += start.n;
    const more = start.run.length - start.n;
    if (more > 0) out.push(`…| (${more} more ${more === 1 ? 'line' : 'lines'})`);
  }
  return { text: out.join('\n'), shown, total, cut: shown < total };
}

type Line = { line: number; text: string };

function fmt(l: Line): string {
  return `${l.line}| ${l.text.slice(0, 220)}`;
}

function indentOf(s: string): number {
  return (/^\s*/.exec(s)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/** Net opening brackets on a line, ignoring those inside quotes. */
function balance(s: string): number {
  const bare = s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '');
  let n = 0;
  for (const c of bare) {
    if (c === '{' || c === '(' || c === '[') n++;
    else if (c === '}' || c === ')' || c === ']') n--;
  }
  return n;
}

/** Lines in the comment block that opens the file, 0 when it doesn't start with one. */
function leadingComment(lines: string[]): number {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const first = lines[i]?.trim() ?? '';
  if (first.startsWith('/*')) {
    while (i < lines.length && !lines[i].includes('*/')) i++;
    return i + 1;
  }
  if (/^(\/\/|#(?!!)|--)/.test(first)) {
    while (i < lines.length && /^\s*(\/\/|#(?!!)|--)/.test(lines[i])) i++;
    return i;
  }
  return 0;
}
