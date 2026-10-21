// Checks AI citations against the real code. A citation is "verified" only when
// its quoted snippet is actually found in the file; the line is corrected to where
// the quote really is. This is what backs the "checked against the code" badge.

import type { Citation, WalkthroughStep } from '../store/types';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Finds `quote` in `lines` nearest to `claimedLine` (1-based).
 * Returns the corrected 1-based line, or undefined if the quote isn't in the file.
 */
export function locateQuote(lines: string[], claimedLine: number, quote: string): number | undefined {
  const q = squash(quote);
  if (q.length < 3) return undefined;
  const claimed = Math.min(Math.max(claimedLine - 1, 0), Math.max(lines.length - 1, 0));

  for (let distance = 0; distance < lines.length; distance++) {
    for (const i of distance === 0 ? [claimed] : [claimed - distance, claimed + distance]) {
      if (i >= 0 && i < lines.length && squash(lines[i]).includes(q)) return i + 1;
    }
  }

  // The quote may span lines. A match "starts" at line i when the window from i
  // contains it but the window from i + 1 doesn't; prefer starts nearest the claim.
  const windowHas = (i: number) => i < lines.length && squash(lines.slice(i, i + 4).join(' ')).includes(q);
  for (let distance = 0; distance < lines.length; distance++) {
    for (const i of distance === 0 ? [claimed] : [claimed - distance, claimed + distance]) {
      if (i >= 0 && windowHas(i) && !windowHas(i + 1)) return i + 1;
    }
  }
  return undefined;
}

/** Looks up file text by workspace-relative path; undefined when the file wasn't read. */
export type FileLookup = (file: string) => string[] | undefined;

export function verifyCitation(c: Citation, lookup: FileLookup): Citation {
  const lines = lookup(c.file);
  if (!lines) return { ...c, verified: false };
  if (c.quote) {
    const found = locateQuote(lines, c.line, c.quote);
    return found ? { ...c, line: found, verified: true } : { ...c, verified: false };
  }
  return { ...c, line: Math.min(c.line, Math.max(lines.length, 1)), verified: false };
}

export function verifyAll(cs: Citation[], lookup: FileLookup): Citation[] {
  return cs.map((c) => verifyCitation(c, lookup));
}

/** "checked" when every citation verified, "partly" when some did, "guess" when none (or none given). */
export function trustLevel(cs: Citation[]): 'checked' | 'partly' | 'guess' {
  if (cs.length === 0) return 'guess';
  const ok = cs.filter((c) => c.verified).length;
  return ok === cs.length ? 'checked' : ok > 0 ? 'partly' : 'guess';
}

/** Drops steps outside the given files and moves each step to where its quote really is. */
export function verifySteps(steps: WalkthroughStep[], sources: { file: string; lines: string[] }[]): WalkthroughStep[] {
  const out: WalkthroughStep[] = [];
  for (const st of steps) {
    const src = sources.find((s) => s.file === st.file) ?? sources.find((s) => s.file.endsWith(`/${st.file}`));
    if (!src) continue;
    const span = st.endLine ? st.endLine - st.line : 0;
    const found = st.quote ? locateQuote(src.lines, st.line, st.quote) : undefined;
    const line = found ?? Math.min(st.line, src.lines.length);
    out.push({ ...st, file: src.file, line, ...(st.endLine ? { endLine: Math.min(line + span, src.lines.length) } : {}), verified: !!found });
  }
  return out;
}
