// Decides which code "What's happening here?" explains when nothing is selected.
// Pure (no vscode import) so it can be tested: the caller passes in what the language
// extension reported, as plain line spans.

/** 0-based inclusive line range. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A symbol from the language extension, e.g. a method or class. */
export interface SymbolSpan extends LineSpan {
  name: string;
  /** "method", "class", ... or '' when the kind says little (a variable holding an arrow function). */
  word: string;
  kind: 'function' | 'type';
}

/** One rung of the ladder from the cursor line out to the whole file. */
export interface Scope extends LineSpan {
  kind: 'function' | 'type' | 'block';
  /** "method GetActivePayments", or the block's first line. */
  label?: string;
}

/** Largest function explained whole by default, and largest block when the function is bigger. */
export const MAX_FUNCTION_LINES = 120;
export const MAX_BLOCK_LINES = 60;

const size = (s: LineSpan) => s.end - s.start + 1;
const contains = (outer: LineSpan, inner: LineSpan) => outer.start <= inner.start && outer.end >= inner.end;

/**
 * Builds the ladder of nested scopes around `cursor`, smallest first.
 * `spans` come from the language's "Expand selection" ranges; `symbols` from its outline.
 * Without syntax ranges (no language support, or it was too slow), blocks come from indentation.
 */
export function scopeLadder(cursor: number, lines: string[], spans: LineSpan[], symbols: SymbolSpan[]): Scope[] {
  const last = Math.max(0, lines.length - 1);
  const clamp = (s: LineSpan): LineSpan => ({ start: Math.max(0, s.start), end: Math.min(last, s.end) });
  const around = (s: LineSpan) => s.start <= cursor && s.end >= cursor;

  const syms = symbols.map((s) => ({ ...s, ...clamp(s) })).filter(around);
  let raw = spans.map(clamp).filter(around);
  if (!raw.length) raw = indentSpans(lines, cursor);

  // A symbol names the span it matches. Outlines and syntax ranges often start a few lines apart
  // (attributes, doc comments, a signature before the braces), so the end line must match and
  // the start be close; the merged span starts at the earlier of the two.
  const named = new Map<string, Scope>();
  const key = (s: LineSpan) => `${s.start}-${s.end}`;
  for (const s of [{ start: cursor, end: cursor }, ...raw]) named.set(key(s), { ...s, kind: 'block' });
  for (const sym of [...syms].sort((a, b) => size(a) - size(b))) {
    const match = [...named.values()]
      .filter((s) => s.kind === 'block' && s.end === sym.end && Math.abs(s.start - sym.start) <= 3)
      .sort((a, b) => Math.abs(a.start - sym.start) - Math.abs(b.start - sym.start) || a.start - b.start)[0];
    const scope: Scope = { start: Math.min(match?.start ?? sym.start, sym.start), end: sym.end, kind: sym.kind, label: [sym.word, sym.name].filter(Boolean).join(' ') };
    if (match) named.delete(key(match));
    named.set(key(scope), scope);
  }

  // Keep a clean chain where each rung contains the one before it.
  const sorted = [...named.values()].sort((a, b) => size(a) - size(b) || b.start - a.start);
  const ladder: Scope[] = [];
  for (const s of sorted) {
    if (!ladder.length || contains(s, ladder[ladder.length - 1])) ladder.push(s);
  }
  // Drop blocks that are nearly a named scope (a method's body without its signature, a class's
  // braces), so Smaller and Larger always visibly change something.
  const kept = ladder.filter((s, i) => {
    if (i === 0 || s.kind !== 'block') return true;
    const named = ladder.slice(i + 1).find((o) => o.kind !== 'block');
    return !named || size(named) - size(s) > 3;
  });
  for (const s of kept) {
    if (s.kind === 'block' && size(s) > 1) s.label = firstLine(lines, s);
  }
  return kept;
}

/**
 * The rung to explain by default: the outermost function that fits, else the largest block
 * that fits (so a cursor deep in a long method gets its loop or `if`), else the cursor line.
 */
export function defaultScope(ladder: Scope[]): number {
  let pick = -1;
  ladder.forEach((s, i) => {
    if (s.kind === 'function' && size(s) <= MAX_FUNCTION_LINES) pick = i;
  });
  if (pick >= 0) return pick;
  ladder.forEach((s, i) => {
    if (size(s) <= MAX_BLOCK_LINES) pick = i;
  });
  return Math.max(0, pick);
}

/** "method ProcessPayment, lines 10-300": the named scope around rung `index`, for context. */
export function enclosingLabel(ladder: Scope[], index: number): string | undefined {
  const outer = ladder.slice(index + 1).find((s) => s.kind !== 'block' && s.label);
  return outer && `${outer.label}, lines ${outer.start + 1}-${outer.end + 1}`;
}

/**
 * Nested blocks around `cursor` found from indentation and closing brackets, for files
 * the language extension can't describe. Works for brace and indentation languages.
 */
export function indentSpans(lines: string[], cursor: number): LineSpan[] {
  const n = lines.length;
  if (!n) return [];
  const blank = (i: number) => !lines[i].trim();
  const indent = (i: number) => (/^\s*/.exec(lines[i])?.[0] ?? '').replace(/\t/g, '    ').length;
  const opener = (i: number) => /^\s*[{([]\s*$/.test(lines[i]);
  const closer = (i: number) => /^\s*([}\])]|end\b)/.test(lines[i]);

  let c = cursor;
  while (c < n - 1 && blank(c)) c++;
  const out: LineSpan[] = [];
  let start = c;
  let end = c;
  let level = indent(c);
  for (let guard = 0; guard < 50; guard++) {
    let s = start;
    let e = end;
    while (s > 0 && (blank(s - 1) || indent(s - 1) >= level)) s--;
    while (e < n - 1 && (blank(e + 1) || indent(e + 1) >= level)) e++;
    while (s < start && blank(s)) s++;
    while (e > end && blank(e)) e--;
    out.push({ start: s, end: e });
    if (s === 0 || level === 0) break;

    // Take in the header line above and a closing bracket line below.
    let h = s - 1;
    while (h > 0 && blank(h)) h--;
    if (opener(h) && h > 0) h--; // "{" on its own line: the header is above it
    while (h > 0 && blank(h)) h--;
    const headerIndent = indent(h);
    let f = e;
    if (f < n - 1 && closer(f + 1) && indent(f + 1) <= headerIndent) f++;
    out.push({ start: h, end: f });
    start = h;
    end = f;
    level = headerIndent;
  }
  return out;
}

function firstLine(lines: string[], s: LineSpan): string | undefined {
  for (let i = s.start; i <= s.end; i++) {
    const t = lines[i]?.trim();
    if (t && !/^[{([]$/.test(t)) return t.length > 48 ? `${t.slice(0, 47)}…` : t;
  }
  return undefined;
}
