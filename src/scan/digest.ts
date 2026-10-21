// Builds the text the AI reads to understand a repo, within a size budget. Pure.

import { classify, folderSummary, regexOutline, sampleOrder } from './classify';

export interface RepoFile {
  path: string; // workspace-relative, forward slashes
  text: string;
  size: number;
  /** Symbol outline from a language extension, if one was available. */
  outline?: string[];
}

export interface DigestOptions {
  repoName: string;
  /** Rough character budget for the whole digest. */
  budget: number;
}

export interface Digest {
  text: string;
  sampledFiles: string[];
}

export function buildDigest(files: RepoFile[], opts: DigestOptions): Digest {
  const parts: string[] = [];
  let used = 0;
  const add = (s: string) => {
    parts.push(s);
    used += s.length + 1;
  };
  const left = () => opts.budget - used;

  add(`# Repository: ${opts.repoName}\n`);
  add(`## Folder layout\n${folderSummary(files.map((f) => f.path)).join('\n')}\n`);

  const paths = files.map((f) => f.path).sort();
  const pathBudget = Math.min(opts.budget * 0.12, 30_000);
  let pathText = '';
  let shown = 0;
  for (const p of paths) {
    if (pathText.length + p.length + 1 > pathBudget) break;
    pathText += `${p}\n`;
    shown++;
  }
  add(`## Files (${paths.length} total${shown < paths.length ? `, first ${shown} shown` : ''})\n${pathText}`);

  const instructions = files.filter((f) => classify(f.path) === 'instruction');
  if (instructions.length) {
    add('## Instruction, convention and documentation files');
    const each = Math.max(1500, Math.floor(Math.min(opts.budget * 0.25, 60_000) / instructions.length));
    for (const f of instructions) {
      if (left() < 2000) break;
      add(fileBlock(f.path, clip(f.text, Math.min(each, 8000))));
    }
  }

  const manifests = files.filter((f) => classify(f.path) === 'manifest');
  if (manifests.length) {
    add('## Manifests and configuration');
    const each = Math.max(800, Math.floor(Math.min(opts.budget * 0.12, 25_000) / manifests.length));
    for (const f of manifests) {
      if (left() < 2000) break;
      add(fileBlock(f.path, clip(f.text, Math.min(each, 4000))));
    }
  }

  const code = files.filter((f) => classify(f.path) === 'code');
  const order = sampleOrder(code.map((f) => ({ path: f.path, size: f.size })));
  const byPath = new Map(code.map((f) => [f.path, f]));
  const sampled: string[] = [];
  add('## Code samples (outline, then the start of the file; line numbers are 1-based)');
  for (const p of order) {
    if (left() < 1500) break;
    const f = byPath.get(p)!;
    const outline = f.outline?.length ? f.outline : regexOutline(f.text);
    const headLines = sampled.length < 25 ? 80 : 30;
    const head = numbered(f.text, headLines);
    const block = fileBlock(p, `Outline:\n${outline.join('\n') || '(none)'}\n\nStart:\n${head}`);
    if (block.length > left()) continue;
    add(block);
    sampled.push(p);
  }

  return { text: parts.join('\n'), sampledFiles: sampled };
}

export function numbered(text: string, maxLines: number, startLine = 1): string {
  return text
    .split(/\r?\n/)
    .slice(startLine - 1, startLine - 1 + maxLines)
    .map((l, i) => `${startLine + i}| ${l.slice(0, 220)}`)
    .join('\n');
}

function fileBlock(path: string, body: string): string {
  return `### ${path}\n\`\`\`\n${body}\n\`\`\`\n`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

export interface Occurrence {
  file: string;
  line: number; // 1-based
  text: string;
}

/**
 * Finds where any of `tokens` appears as a whole word, spread across files so the
 * examples aren't all from one place.
 */
export function findOccurrences(files: RepoFile[], tokens: string[], max = 4): Occurrence[] {
  const words = tokens.filter((t) => /^[A-Za-z_$][\w$]*$/.test(t));
  if (words.length === 0) return [];
  const re = new RegExp(`(^|[^\\w$])(${words.map(escapeRe).join('|')})(?![\\w$])`);
  const found: Occurrence[] = [];
  const seenFiles = new Set<string>();
  for (const f of files) {
    if (classify(f.path) !== 'code') continue;
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        found.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        seenFiles.add(f.path);
        break; // one per file first
      }
    }
    if (seenFiles.size >= max) break;
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Requests a full scan will make: one map request plus concept batches. */
export function estimateRequests(expectedConcepts: number, batchSize: number): number {
  return 1 + Math.ceil(expectedConcepts / batchSize);
}

/** Files added, changed or removed between two hash snapshots. */
export function changedFiles(before: Record<string, string>, after: Record<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [path, h] of Object.entries(after)) if (before[path] !== h) changed.add(path);
  for (const path of Object.keys(before)) if (!(path in after)) changed.add(path);
  return changed;
}
