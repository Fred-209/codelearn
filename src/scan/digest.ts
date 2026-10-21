// Builds the text the AI reads to understand a repo, within a size budget. Pure.

import { classify, folderSummary, isLowValue, regexOutline } from './classify';
import { excerpt } from './excerpt';
import { redactSecrets } from './redact';
import { indexRepo, RepoIndex } from './repoIndex';

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
  /** The repo's static index, when the caller already built it. */
  index?: RepoIndex;
}

export interface Digest {
  text: string;
  sampledFiles: string[];
  index: RepoIndex;
}

/**
 * The repo for the AI, most telling parts first: layout, entry points, the files everything
 * depends on, where cross-cutting topics live, instruction files, manifests, templates, the
 * file list, and then code from the most important files down, spread across the repo.
 */
export function buildDigest(files: RepoFile[], opts: DigestOptions): Digest {
  const index = opts.index ?? indexRepo(files);
  const parts: string[] = [];
  let used = 0;
  const add = (s: string) => {
    parts.push(s);
    used += s.length + 1;
  };
  const left = () => opts.budget - used;
  const byPath = new Map(files.map((f) => [f.path, f]));

  add(`# Repository: ${opts.repoName}\n`);
  add(`## Folder layout\n${folderSummary(files.map((f) => f.path)).join('\n')}\n`);

  if (index.entryPoints.length) {
    add(`## Entry points (from build configs, package scripts, startup file names and startup code)\n${index.entryPoints.map((e) => `- ${e.path}: ${e.why}`).join('\n')}\n`);
  }

  const central = [...index.importedBy]
    .map(([path, users]) => ({ path, users: [...users].filter((u) => !isLowValue(u)).length }))
    .filter((c) => c.users >= 3 && byPath.has(c.path) && !isLowValue(c.path))
    .sort((a, b) => b.users - a.users || a.path.localeCompare(b.path))
    .slice(0, 20);
  if (central.length) {
    add(`## Files the most other files depend on\n${central.map((c) => `- ${c.path}: used by ${c.users} files`).join('\n')}\n`);
  }
  if (index.packages.length) {
    add(`## External packages imported most\n${index.packages.slice(0, 20).map(([name, n]) => `${name} (${n})`).join(', ')}\n`);
  }

  if (index.topics.length) {
    const lines = ['## Cross-cutting topics (found by searching file names and code; each needs a home in the areas or flows)'];
    for (const t of index.topics) {
      lines.push(`### ${t.name}`);
      for (const h of t.hits) lines.push(`- ${h.path}:${h.line}  ${h.text}`);
    }
    add(`${lines.join('\n')}\n`);
  }

  const instructions = files.filter((f) => classify(f.path) === 'instruction');
  if (instructions.length) {
    add('## Instruction, convention and documentation files');
    const each = Math.max(1500, Math.floor(Math.min(opts.budget * 0.2, 50_000) / instructions.length));
    for (const f of instructions) {
      if (left() < 2000) break;
      add(fileBlock(f.path, clip(f.text, Math.min(each, 8000))));
    }
  }

  const manifests = files.filter((f) => classify(f.path) === 'manifest');
  if (manifests.length) {
    add('## Manifests and configuration');
    const each = Math.max(800, Math.floor(Math.min(opts.budget * 0.1, 20_000) / manifests.length));
    for (const f of manifests) {
      if (left() < 2000) break;
      add(fileBlock(f.path, clip(f.text, Math.min(each, 4000))));
    }
  }

  const deploys = files.filter((f) => classify(f.path) === 'deploy').sort((a, b) => deployRank(a.path) - deployRank(b.path) || a.path.localeCompare(b.path));
  if (deploys.length) {
    add('## How it is built, deployed and hosted (pipelines, infrastructure as code, containers and hosting config)');
    const cap = Math.min(opts.budget * 0.1, 30_000);
    const each = Math.max(1200, Math.floor(cap / deploys.length));
    let spent = 0;
    for (const f of deploys) {
      if (left() < 2000 || spent > cap) break;
      const block = fileBlock(f.path, clip(f.text, Math.min(each, 6000)));
      add(block);
      spent += block.length;
    }
  }

  const t = index.templates;
  if (t.count) {
    const lines = [`## Templates and markup (${t.count} files: ${t.byExtension.map(([e, n]) => `${n} ${e}`).join(', ')})`];
    if (t.attributes.length) lines.push(`Attributes used most: ${t.attributes.map(([a, n]) => `${a} (${n})`).join(', ')}`);
    if (t.syntax.length) lines.push(`Template syntax seen: ${t.syntax.map(([s, n]) => `${s} in ${n} files`).join(', ')}`);
    add(lines.join('\n'));
    for (const p of t.top) {
      const f = byPath.get(p);
      if (!f || left() < 4000) break;
      const users = [...(index.importedBy.get(p) ?? [])].slice(0, 2);
      add(fileBlock(`${p}${users.length ? ` (used by ${users.join(', ')})` : ''}`, numbered(f.text, 30)));
    }
  }

  const paths = files.map((f) => f.path).sort();
  const pathBudget = Math.min(opts.budget * 0.1, 30_000);
  let pathText = '';
  let shown = 0;
  for (const p of paths) {
    if (pathText.length + p.length + 1 > pathBudget) break;
    pathText += `${p}\n`;
    shown++;
  }
  add(`## Files (${paths.length} total${shown < paths.length ? `, first ${shown} shown` : ''})\n${pathText}`);

  const entries = new Map(index.entryPoints.map((e) => [e.path, e.why]));
  const sampled: string[] = [];
  add('## Code, most important files first (imports left out; "…|" marks code not shown; line numbers are 1-based)');
  for (const p of index.ranked) {
    if (left() < 1500) break;
    const f = byPath.get(p);
    if (!f) continue;
    const n = sampled.length;
    const ex = excerpt(f.text, n < 20 ? 110 : n < 60 ? 55 : 28);
    const users = index.importedBy.get(p)?.size ?? 0;
    const notes = [entries.get(p) && `entry point: ${entries.get(p)}`, users && `used by ${users} files`].filter(Boolean).join('; ');
    const outline = ex.cut ? (f.outline?.length ? f.outline : regexOutline(f.text)).slice(0, 30) : [];
    const body = `${outline.length ? `Outline:\n${outline.join('\n')}\n\nCode:\n` : ''}${ex.text || '(empty)'}`;
    const block = fileBlock(`${p}${notes ? ` (${notes})` : ''}`, body);
    if (block.length > left()) continue;
    add(block);
    sampled.push(p);
  }

  return { text: redactSecrets(parts.join('\n')), sampledFiles: sampled, index };
}

/** Pipelines first (they name what gets deployed where), then hosting config, then the rest. */
function deployRank(path: string): number {
  if (/workflows\/|pipelines?|\.gitlab-ci|bitbucket|circleci|Jenkinsfile|cloudbuild|buildspec|appveyor|travis/i.test(path)) return 0;
  if (/staticwebapp|swa-cli|host\.json|function\.json|vercel|netlify|firebase|fly\.toml|wrangler|Procfile|azure\.ya?ml|app\.ya?ml/i.test(path)) return 1;
  if (/Dockerfile|Containerfile|docker-compose/i.test(path)) return 2;
  return 3;
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
 * Finds where any of `tokens` appears as a whole word, or any of `patterns` appears as written,
 * in code and templates. Spread across files (one hit per file), real code before tests and examples.
 */
export function findOccurrences(files: RepoFile[], tokens: string[], max = 4, patterns: string[] = []): Occurrence[] {
  const words = tokens.filter((t) => /^[A-Za-z_$][\w$]*$/.test(t));
  const literal = patterns.map((p) => p.trim()).filter((p) => p.length >= 3);
  if (words.length === 0 && literal.length === 0) return [];
  const re = words.length ? new RegExp(`(^|[^\\w$])(${words.map(escapeRe).join('|')})(?![\\w$])`) : undefined;
  const hit = (line: string) => (re?.test(line) ?? false) || literal.some((p) => line.includes(p));
  const searchable = files.filter((f) => {
    const role = classify(f.path);
    return role === 'code' || role === 'template';
  });
  const ordered = [...searchable.filter((f) => !isLowValue(f.path)), ...searchable.filter((f) => isLowValue(f.path))];
  const found: Occurrence[] = [];
  for (const f of ordered) {
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length <= 1000 && hit(lines[i])) {
        found.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        break; // one per file
      }
    }
    if (found.length >= max) break;
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

/**
 * Files that differ from what the map was built from. Maps from before codelearn read templates
 * have no hashes for them, so templates new to such a map don't count.
 */
export function changedSinceMap(map: { fileHashes: Record<string, string>; templatesUntracked?: boolean }, hashes: Record<string, string>): Set<string> {
  const changed = changedFiles(map.fileHashes, hashes);
  if (map.templatesUntracked) {
    for (const p of [...changed]) if (!(p in map.fileHashes) && classify(p) === 'template') changed.delete(p);
  }
  return changed;
}

const DEPLOY_LINE =
  /(app_location|api_location|output_location|app_artifact_location|static-web-apps|staticSites|StaticWebApp|AzureStaticWebApp|azure\/functions|functionapp|AzureFunctionApp|webapps?-deploy|AzureWebApp|Microsoft\.Web\/(sites|staticSites|serverfarms)|containerapp|Microsoft\.App\/|aks|kubernetes|kubectl|helm |docker (build|push)|FROM |runs-on|environment:|on:|branches:|trigger:|stage:|resource\s|module\s|"routes"|"navigationFallback"|"platform"|apiRuntime|"bindings"|"type": *"\w+Trigger"|deploy|publish)/i;

/** The lines of the deployment files that say what is deployed where, for the final synthesis. */
export function deploymentSummary(files: RepoFile[], maxFiles = 12, linesEach = 14): string {
  const deploys = files.filter((f) => classify(f.path) === 'deploy').sort((a, b) => deployRank(a.path) - deployRank(b.path) || a.path.localeCompare(b.path));
  const blocks: string[] = [];
  for (const f of deploys.slice(0, maxFiles)) {
    const lines = f.text
      .split(/\r?\n/)
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.trim() && DEPLOY_LINE.test(l))
      .slice(0, linesEach)
      .map(({ l, i }) => `${i + 1}| ${l.slice(0, 160)}`);
    if (lines.length) blocks.push(`${f.path}:\n${lines.join('\n')}`);
  }
  return redactSecrets(blocks.join('\n\n'));
}

/** Files added, changed or removed between two hash snapshots. */
export function changedFiles(before: Record<string, string>, after: Record<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [path, h] of Object.entries(after)) if (before[path] !== h) changed.add(path);
  for (const path of Object.keys(before)) if (!(path in after)) changed.add(path);
  return changed;
}
