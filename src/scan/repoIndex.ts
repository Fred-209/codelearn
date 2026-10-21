// A picture of the repo built without AI: where it starts, who imports whom, which files
// matter most, and where cross-cutting topics such as sign-in live. Pure.

import { classify, ENTRY_NAMES, isLowValue } from './classify';
import type { RepoFile } from './digest';
import { codeLines, IMPORT_LINE } from './excerpt';

export interface EntryPoint {
  path: string;
  /** Why it counts as one, e.g. "build entry in webpack.designer.js". */
  why: string;
}

export interface TopicHit {
  path: string;
  line: number; // 1-based
  text: string;
}

export interface Topic {
  id: string;
  name: string;
  hits: TopicHit[];
}

export interface TemplateSummary {
  count: number;
  byExtension: [string, number][];
  /** Attribute names used most, e.g. data-bind, v-if, asp-for, with how often. */
  attributes: [string, number][];
  /** Template syntax seen, with the number of files using it. */
  syntax: [string, number][];
  /** Templates worth showing, most used first. */
  top: string[];
}

export interface RepoIndex {
  entryPoints: EntryPoint[];
  /** Code files, most important first, spread across the repo's parts. */
  ranked: string[];
  /** Repo files each file imports or refers to. */
  imports: Map<string, Set<string>>;
  /** Files that import or refer to each file. */
  importedBy: Map<string, Set<string>>;
  /** External packages and how many files import each, most used first. */
  packages: [string, number][];
  topics: Topic[];
  templates: TemplateSummary;
  score: Map<string, number>;
  /** The part of the repo a file belongs to, used to spread samples: "src/services". */
  groupOf(path: string): string;
}

export function indexRepo(files: RepoFile[]): RepoIndex {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const has = (p: string) => byPath.has(p);
  const code = files.filter((f) => classify(f.path) === 'code');

  const { imports, packages } = importGraph(files, has);
  const importedBy = invert(imports);
  const entryPoints = findEntryPoints(files, has);
  const entries = new Set(entryPoints.map((e) => e.path));
  const base = scoreFiles(code, imports, importedBy, entries);
  const topics = probeTopics(code, base);
  const score = new Map(base);
  for (const t of topics) for (const h of t.hits) score.set(h.path, (score.get(h.path) ?? 0) + 1.5);
  const groupOf = grouper(code.map((f) => f.path));
  const first = wiring(entryPoints, imports, score);
  const pinned = new Set(first);
  return {
    entryPoints,
    ranked: [
      ...first,
      ...spread(
        code.map((f) => f.path).filter((p) => !pinned.has(p)),
        score,
        groupOf,
      ),
    ],
    imports,
    importedBy,
    packages,
    topics,
    templates: summarizeTemplates(
      files.filter((f) => classify(f.path) === 'template'),
      importedBy,
    ),
    score,
    groupOf,
  };
}

// ---- imports ----

const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte)$/i;
const JS_STATIC = /(?:^|[;\s])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g;
const JS_DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const JS_TRY = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.vue'];
const PY_FILE = /\.py$/i;
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w \t,*]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;
const GO_FILE = /\.go$/i;
const GO_BLOCK = /^import\s*\(([\s\S]*?)^\)/gm;
const GO_SINGLE = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const C_FILE = /\.(c|h|cc|cpp|hpp|m|mm)$/i;
const C_INCLUDE = /^\s*#\s*include\s+"([^"]+)"/gm;
/** Languages that refer to types by name without importing files: linked by the type names they mention. */
const TYPE_REF_FILE = /\.(cs|fs|vb|swift|php|rb|dart|java|kt|kts|scala)$/i;
const DECLARES = /\b(?:class|interface|record|struct|enum|trait|protocol|object|module)\s+([A-Z][A-Za-z0-9_]{2,})/g;
const TYPE_NAME = /\b[A-Z][A-Za-z0-9_]{2,}\b/g;

function importGraph(files: RepoFile[], has: (p: string) => boolean): { imports: Map<string, Set<string>>; packages: [string, number][] } {
  const imports = new Map<string, Set<string>>();
  const link = (from: string, to: string | undefined) => {
    if (!to || to === from) return;
    const set = imports.get(from) ?? new Set<string>();
    set.add(to);
    imports.set(from, set);
  };
  const packageFiles = new Map<string, Set<string>>();
  const ts = tsResolution(files);
  const py = pythonModules(files);
  const goMods = goModules(files);
  const goDirs = new Map<string, string[]>();
  for (const f of files) {
    if (GO_FILE.test(f.path) && !/_test\.go$/.test(f.path)) goDirs.set(dirOf(f.path), [...(goDirs.get(dirOf(f.path)) ?? []), f.path]);
  }
  const byBase = new Map<string, string[]>();
  for (const f of files) byBase.set(baseName(f.path), [...(byBase.get(baseName(f.path)) ?? []), f.path]);

  for (const f of files) {
    const p = f.path;
    if (JS_FILE.test(p)) {
      for (const re of [JS_STATIC, JS_DYNAMIC]) {
        for (const m of f.text.matchAll(re)) {
          const spec = m[1];
          const target = resolveJsSpec(p, spec, has, ts);
          if (target) link(p, target);
          else if (!spec.startsWith('.') && !spec.startsWith('/')) {
            const name = packageName(spec);
            if (name) packageFiles.set(name, (packageFiles.get(name) ?? new Set()).add(p));
          }
        }
      }
    } else if (PY_FILE.test(p)) {
      for (const m of f.text.matchAll(PY_FROM)) {
        const [, dots, mod, names] = m;
        if (dots) {
          let dir = dirOf(p);
          for (let i = 1; i < dots.length; i++) dir = dirOf(dir);
          const base = mod ? join(dir, mod.replace(/\./g, '/')) : dir;
          const asModule = pyFile(base, has);
          if (asModule && mod) link(p, asModule);
          else for (const n of names.split(',').map((x) => x.trim()).filter((x) => /^\w+$/.test(x))) link(p, pyFile(join(base, n), has) ?? asModule);
        } else {
          const target = py.get(mod) ?? undefined;
          if (target) link(p, target);
          for (const n of names.split(',').map((x) => x.trim()).filter((x) => /^\w+$/.test(x))) link(p, py.get(`${mod}.${n}`));
          if (!target) {
            const name = mod.split('.')[0];
            if (name) packageFiles.set(name, (packageFiles.get(name) ?? new Set()).add(p));
          }
        }
      }
      for (const m of f.text.matchAll(PY_IMPORT)) {
        for (const mod of m[1].split(',').map((x) => x.trim())) {
          const target = py.get(mod);
          if (target) link(p, target);
          else packageFiles.set(mod.split('.')[0], (packageFiles.get(mod.split('.')[0]) ?? new Set()).add(p));
        }
      }
    } else if (GO_FILE.test(p)) {
      const specs = [...[...f.text.matchAll(GO_BLOCK)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])), ...[...f.text.matchAll(GO_SINGLE)].map((m) => m[1])];
      for (const spec of specs) {
        const mod = goMods.find((g) => spec === g.module || spec.startsWith(`${g.module}/`));
        if (!mod) {
          if (spec.includes('.')) packageFiles.set(spec.split('/').slice(0, 3).join('/'), (packageFiles.get(spec.split('/').slice(0, 3).join('/')) ?? new Set()).add(p));
          continue;
        }
        const dir = join(mod.dir, spec.slice(mod.module.length).replace(/^\//, ''));
        for (const target of goDirs.get(dir) ?? []) link(p, target);
      }
    } else if (C_FILE.test(p)) {
      for (const m of f.text.matchAll(C_INCLUDE)) {
        const rel = join(dirOf(p), m[1]);
        const candidates = byBase.get(baseName(m[1])) ?? [];
        link(p, has(rel) ? rel : candidates.length === 1 ? candidates[0] : undefined);
      }
    }
  }

  // Type-name references, for languages without file imports.
  const typed = files.filter((f) => TYPE_REF_FILE.test(f.path));
  const declaredIn = new Map<string, string[]>();
  for (const f of typed) {
    for (const m of f.text.matchAll(DECLARES)) {
      const list = declaredIn.get(m[1]) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      declaredIn.set(m[1], list);
    }
  }
  if (declaredIn.size) {
    for (const f of typed) {
      const names = new Set<string>();
      for (const m of f.text.matchAll(TYPE_NAME)) {
        names.add(m[0]);
        if (names.size > 600) break;
      }
      for (const n of names) {
        const where = declaredIn.get(n);
        if (where && where.length <= 2 && !where.includes(f.path)) for (const w of where) link(f.path, w);
      }
    }
  }

  const packages = [...packageFiles].map(([name, set]) => [name, set.size] as [string, number]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { imports, packages };
}

interface TsResolution {
  /** "@app/" -> ["src/app/"] from tsconfig paths. */
  aliases: { prefix: string; targets: string[] }[];
  /** Folders bare imports may be relative to (baseUrl, src). */
  roots: string[];
}

function tsResolution(files: RepoFile[]): TsResolution {
  const aliases: TsResolution['aliases'] = [];
  const roots = new Set<string>();
  for (const f of files) {
    if (!/^(tsconfig|jsconfig)(\.base)?\.json$/i.test(f.path)) continue;
    const options = (parseJsonc(f.text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined)?.compilerOptions;
    const baseUrl = typeof options?.baseUrl === 'string' ? join('', options.baseUrl) : '';
    if (baseUrl) roots.add(baseUrl);
    for (const [key, targets] of Object.entries(options?.paths ?? {})) {
      if (!Array.isArray(targets)) continue;
      aliases.push({
        prefix: key.replace(/\*$/, ''),
        targets: targets.filter((t) => typeof t === 'string').map((t) => join(baseUrl, t.replace(/\*$/, '')) + (t.endsWith('/*') ? '/' : '')),
      });
    }
  }
  roots.add('src');
  roots.add('');
  return { aliases, roots: [...roots] };
}

function resolveJsSpec(from: string, spec: string, has: (p: string) => boolean, ts: TsResolution): string | undefined {
  const clean = spec.replace(/[?#].*$/, '');
  if (clean.startsWith('.')) return resolveJs(join(dirOf(from), clean), has);
  if (clean.startsWith('/')) return resolveJs(join('', clean), has);
  for (const a of ts.aliases) {
    if (!clean.startsWith(a.prefix)) continue;
    for (const t of a.targets) {
      const found = resolveJs(join('', t + clean.slice(a.prefix.length)), has);
      if (found) return found;
    }
  }
  for (const root of ts.roots) {
    const found = resolveJs(join(root, clean), has);
    if (found) return found;
  }
  return undefined;
}

function resolveJs(base: string, has: (p: string) => boolean): string | undefined {
  for (const ext of JS_TRY) if (has(base + ext)) return base + ext;
  // "./x.js" written for x.ts (ESM-style TypeScript)
  const js = /\.(m|c)?js$/.exec(base);
  if (js) {
    const stem = base.slice(0, -js[0].length);
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (has(stem + ext)) return stem + ext;
  }
  return undefined;
}

/** "@scope/pkg/sub" -> "@scope/pkg", "lodash/fp" -> "lodash", "node:fs" -> "fs". */
export function packageName(spec: string): string | undefined {
  const s = spec.replace(/^node:/, '');
  if (!/^[@\w]/.test(s)) return undefined;
  const parts = s.split('/');
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Dotted module names for every Python file, from each folder it could be imported relative to. */
function pythonModules(files: RepoFile[]): Map<string, string> {
  const out = new Map<string, string>();
  const pyFiles = files.filter((f) => PY_FILE.test(f.path)).map((f) => f.path).sort((a, b) => a.length - b.length);
  for (const p of pyFiles) {
    const parts = p.replace(/\.py$/i, '').split('/');
    if (parts[parts.length - 1] === '__init__') parts.pop();
    for (let i = 0; i < parts.length; i++) {
      const name = parts.slice(i).join('.');
      if (name && !out.has(name)) out.set(name, p);
    }
  }
  return out;
}

function pyFile(base: string, has: (p: string) => boolean): string | undefined {
  for (const c of [`${base}.py`, `${base}/__init__.py`]) if (has(c)) return c;
  return undefined;
}

function goModules(files: RepoFile[]): { module: string; dir: string }[] {
  return files
    .filter((f) => /(^|\/)go\.mod$/.test(f.path))
    .map((f) => ({ module: /^module\s+(\S+)/m.exec(f.text)?.[1] ?? '', dir: dirOf(f.path) }))
    .filter((g) => g.module);
}

function invert(imports: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [from, tos] of imports) for (const to of tos) out.set(to, (out.get(to) ?? new Set()).add(from));
  return out;
}

// ---- entry points ----

const BUILD_CONFIG = /(^|\/)((webpack|vite|rollup|rspack|esbuild|parcel|tsup|snowpack)[.\w-]*|gulpfile|gruntfile)\.(c|m)?[jt]s$/i;
const DEV_SCRIPT = /^(pre|post)?(test|tests|lint|format|prettier|eslint|stylelint|e2e|coverage|clean|typecheck|check|cy|cypress|playwright|jest|vitest|mocha)([:_-]|$)/i;
const PATH_STRING = /["'`](\.{0,2}\/?[\w@$.\-/]+\.(?:[cm]?[jt]sx?|vue|svelte))["'`]/g;
const STARTS: [RegExp, string][] = [
  [/static\s+(async\s+)?[\w<>]+\s+Main\s*\(|WebApplication\.CreateBuilder|Host\.Create(Default|Application)Builder|CreateHostBuilder|FunctionsApplication\.CreateBuilder/, 'program start'],
  [/^func main\(\)/m, 'program start'],
  [/if\s+__name__\s*==\s*["']__main__["']/, 'program start'],
  [/\b(Flask|FastAPI)\(/, 'web app'],
  [/public\s+static\s+void\s+main\s*\(|@SpringBootApplication/, 'program start'],
  [/^fun main\(/m, 'program start'],
  [/\bcreateRoot\(|ReactDOM\.render\(|bootstrapApplication\(|platformBrowserDynamic\(\)|\bcreateApp\(|new Vue\(/, 'front-end start'],
  [/\.listen\(\s*(\d{2,5}|port\b|PORT\b|process\.env)/, 'server start'],
  [/addEventListener\(\s*["']DOMContentLoaded["']/, 'page start'],
];

function nameReason(path: string): string {
  const name = /([^/]+?)(\.[a-z][\w-]*)?\.[a-z]+$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  if (name === 'index') return 'package entry';
  if (name === 'module') return 'module wiring';
  if (name === 'routes' || name === 'route' || name === 'urls') return 'route table';
  return 'startup file';
}

export function findEntryPoints(files: RepoFile[], has: (p: string) => boolean): EntryPoint[] {
  const reasons = new Map<string, string[]>();
  const add = (path: string, why: string) => {
    if (isLowValue(path)) return;
    const list = reasons.get(path) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(path, list);
  };
  const isCode = (p: string) => has(p) && classify(p) === 'code';

  // Package scripts and fields: the commands people actually run.
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f.path)) continue;
    const pkg = parseJsonc(f.text) as { main?: unknown; module?: unknown; browser?: unknown; bin?: unknown; scripts?: Record<string, unknown> } | undefined;
    if (!pkg) continue;
    const dir = dirOf(f.path);
    for (const field of ['main', 'module', 'browser'] as const) {
      const v = pkg[field];
      if (typeof v === 'string' && isCode(join(dir, v))) add(join(dir, v), `"${field}" in ${f.path}`);
    }
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [];
    for (const b of bins) if (typeof b === 'string' && isCode(join(dir, b))) add(join(dir, b), `command in ${f.path}`);
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      // Test, lint and format runs aren't how the app starts.
      if (typeof cmd !== 'string' || DEV_SCRIPT.test(name)) continue;
      const words = cmd.split(/[\s&|;]+/);
      words.forEach((w, i) => {
        const p = join(dir, w);
        if (!has(p)) return;
        if (BUILD_CONFIG.test(p) || /^(--config|-c)$/.test(words[i - 1] ?? '')) add(p, `build configuration (npm run ${name})`);
        else if (isCode(p)) add(p, `run by npm run ${name}`);
      });
    }
  }

  // Bundler configs name the files each bundle starts from.
  for (const f of files) {
    if (!BUILD_CONFIG.test(f.path)) continue;
    add(f.path, 'build configuration');
    for (const m of f.text.matchAll(PATH_STRING)) {
      const p = join(dirOf(f.path), m[1]);
      if (p !== f.path && isCode(p)) add(p, `build entry in ${f.path}`);
    }
  }

  for (const f of files) {
    if (classify(f.path) !== 'code' || isLowValue(f.path)) continue;
    if (ENTRY_NAMES.test(f.path)) {
      const isIndex = /(^|\/)index\./i.test(f.path);
      if ((!isIndex || f.path.split('/').length <= 2) && !reexportOnly(f.text)) add(f.path, nameReason(f.path));
    }
    for (const [re, why] of STARTS) {
      if (re.test(f.text)) {
        if (why === 'program start' && GO_FILE.test(f.path) && !/^package main\b/m.test(f.text)) continue;
        add(f.path, why);
        break;
      }
    }
  }

  const weight = (why: string[]) => (why.some((w) => w.startsWith('build entry') || w.startsWith('run by') || w.startsWith('"')) ? 3 : 0) + why.length;
  return [...reasons]
    .sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].split('/').length - b[0].split('/').length || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([path, why]) => ({ path, why: why.slice(0, 2).join('; ') }));
}

/** A file whose only code re-exports other files, like an index.ts barrel. */
export function reexportOnly(text: string): boolean {
  const rest = codeLines(text).filter((l) => l.text.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l.text));
  return rest.length === 0 && /\bexport\b[^;\n]*\bfrom\b/.test(text);
}

// ---- importance ----

function scoreFiles(code: RepoFile[], imports: Map<string, Set<string>>, importedBy: Map<string, Set<string>>, entries: Set<string>): Map<string, number> {
  const score = new Map<string, number>();
  for (const f of code) {
    const users = [...(importedBy.get(f.path) ?? [])].filter((p) => !isLowValue(p));
    const uses = imports.get(f.path)?.size ?? 0;
    const lines = f.text.split('\n').length;
    let s = 0;
    if (entries.has(f.path)) s += 6;
    s += 2.5 * Math.log2(1 + users.length);
    s += 0.6 * Math.log2(1 + uses);
    if (users.some((u) => entries.has(u))) s += 2;
    if (lines < 12) s -= 2;
    else if (lines < 25) s -= 0.5;
    if (reexportOnly(f.text)) s -= 4;
    if (isLowValue(f.path)) s -= 6;
    score.set(f.path, s);
  }
  return score;
}

/**
 * Startup code and the modules it wires together (ones that import many files), which explain
 * how the parts fit, so they come before everything else. Surest entry points first.
 */
function wiring(entryPoints: EntryPoint[], imports: Map<string, Set<string>>, score: Map<string, number>): string[] {
  const byScore = (a: string, b: string) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b);
  const reasons = new Map(entryPoints.map((e) => [e.path, e.why.split('; ').length]));
  const starts = entryPoints
    .map((e) => e.path)
    .filter((p) => classify(p) === 'code' && !BUILD_CONFIG.test(p) && !isLowValue(p))
    .sort((a, b) => reasons.get(b)! - reasons.get(a)! || byScore(a, b))
    .slice(0, 8);
  const roots = new Set<string>();
  for (const s of starts) {
    for (const d of imports.get(s) ?? []) if ((imports.get(d)?.size ?? 0) >= 8 && !isLowValue(d) && classify(d) === 'code') roots.add(d);
  }
  return [...new Set([...starts, ...[...roots].sort(byScore).slice(0, 6)])];
}

/**
 * Groups files by top-level folder, splitting any group that holds over 40% of the files
 * into its subfolders, so one big folder (src/, or a components/ folder with a hundred small
 * subfolders) doesn't count as a single part.
 */
export function grouper(paths: string[]): (path: string) => string {
  const keyAt = (p: string, depth: number) => {
    const parts = p.split('/');
    return parts.length > depth ? parts.slice(0, depth).join('/') : parts.slice(0, -1).join('/') || '(root)';
  };
  const members = new Map<string, string[]>();
  const membersOf = (prefix: string) => {
    let list = members.get(prefix);
    if (!list) {
      list = paths.filter((p) => p.startsWith(`${prefix}/`));
      members.set(prefix, list);
    }
    return list;
  };
  const cache = new Map<string, string>();
  return (path: string) => {
    const cached = cache.get(path);
    if (cached) return cached;
    let depth = 1;
    let group = keyAt(path, depth);
    while (depth < 5) {
      const inside = membersOf(group);
      const subfolders = new Set(inside.filter((p) => p.split('/').length > depth + 1).map((p) => keyAt(p, depth + 1)));
      if (inside.length <= paths.length * 0.4 || subfolders.size < 2 || path.split('/').length <= depth + 1) break;
      depth++;
      group = keyAt(path, depth);
    }
    cache.set(path, group);
    return group;
  };
}

/** Most important first, but each extra file from the same group counts for a little less. */
export function spread(paths: string[], score: Map<string, number>, groupOf: (p: string) => string): string[] {
  const queues = new Map<string, string[]>();
  for (const p of paths) queues.set(groupOf(p), [...(queues.get(groupOf(p)) ?? []), p]);
  for (const q of queues.values()) q.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b));
  const picked = new Map<string, number>();
  const out: string[] = [];
  for (;;) {
    let bestGroup: string | undefined;
    let best = -Infinity;
    for (const [g, q] of queues) {
      if (!q.length) continue;
      const v = (score.get(q[0]) ?? 0) - 1.5 * (picked.get(g) ?? 0);
      if (v > best) {
        best = v;
        bestGroup = g;
      }
    }
    if (bestGroup === undefined) return out;
    out.push(queues.get(bestGroup)!.shift()!);
    picked.set(bestGroup, (picked.get(bestGroup) ?? 0) + 1);
  }
}

// ---- cross-cutting topics ----

interface TopicDef {
  id: string;
  name: string;
  path: RegExp;
  code: RegExp;
}

export const TOPICS: TopicDef[] = [
  {
    id: 'sign-in',
    name: 'Sign-in, sessions and tokens',
    path: /auth|login|logout|sign-?in|sign-?up|sso|oauth|oidc|openid|identity|token|session|jwt|msal|aad|b2c|saml|credential|password|permission|claims?\b/i,
    code: /\b(authenticate|authorize|signIn|signOut|login|logout|accessToken|refreshToken|idToken|Bearer|jwt|msal|OAuth|OpenId|ClaimsPrincipal|AddAuthentication|UseAuthentication|AddAuthorization|SignInManager|passport|getToken|acquireToken\w*)\b|\[Authorize/,
  },
  {
    id: 'config',
    name: 'Configuration and settings',
    path: /config|settings|options|environment|constants/i,
    code: /\b(process\.env|IConfiguration|IOptions(Monitor|Snapshot)?<|ConfigurationBuilder|GetSection|dotenv|os\.environ|getenv|GetEnvironmentVariable|import\.meta\.env|ISettingsProvider|getSetting)\b/,
  },
  {
    id: 'routing',
    name: 'Routing and request handling',
    path: /rout|controller|endpoint|handler|middleware|(^|\/)pages?\//i,
    code: /\b(Router|router\.|routes|MapGet|MapPost|MapControllers|app\.(get|post|put|delete|use)\(|createBrowserRouter|RouterModule|urlpatterns|RouteGuard|navigateTo|navigate)\b|\[(Http(Get|Post|Put|Delete|Patch)|Route)\b|@app\.route/,
  },
  {
    id: 'data',
    name: 'Data access and storage',
    path: /repositor|\bdao\b|(^|\/)db\/|persistence|storage|(^|\/)stores?\/|entit(y|ies)|schema|migration|\bsql\b|cache/i,
    code: /\b(DbContext|DbSet<|Dapper|QueryAsync|ExecuteAsync|SqlConnection|SqlCommand|mongoose|prisma|sequelize|knex|typeorm|IRepository|Repository<|localStorage|sessionStorage|indexedDB|IObjectStorage|Redis)\b|\b(SELECT|INSERT INTO|DELETE FROM)\s/,
  },
  {
    id: 'http',
    name: 'Calls to other services and APIs',
    path: /client|(^|\/)api\/|http|proxy|gateway|sdk/i,
    code: /\b(fetch\(|axios|HttpClient|IHttpClientFactory|httpClient\.|XMLHttpRequest|requests\.(get|post|put|delete)|RestTemplate|WebClient|HttpRequestMessage)/,
  },
  {
    id: 'build',
    name: 'Build, publishing and deployment',
    path: /publish|(^|\/)build|deploy|release|webpack|vite\.config|rollup|gulp|grunt|pipeline|dockerfile|\.github\/workflows|azure-pipelines|makefile/i,
    code: /\b(publish\w*|Publisher|bundle|deploy\w*|webpack)\b/,
  },
  {
    id: 'errors',
    name: 'Errors, logging and telemetry',
    path: /error|exception|logging|logger|telemetry|monitor|diagnostic/i,
    code: /\b(ILogger|logger\.(error|warn|warning|info|trace|debug)|console\.error|ErrorHandler|UseExceptionHandler|ExceptionFilter|ProblemDetails|Sentry|ApplicationInsights|appInsights|telemetry|traceError|trackException|logError)\b/,
  },
  {
    id: 'background',
    name: 'Background work and messaging',
    path: /(^|\/|[a-z])(jobs?|workers?|queues?|schedul\w*|cron|background|consumers?|subscribers?|hosted|listeners?)(\/|\.|[A-Z]|$)/i,
    code: /\b(BackgroundService|IHostedService|Hangfire|Quartz|setInterval|ServiceBus|Kafka|RabbitMQ|celery|BullMQ|new Worker\(|postMessage)\b|\bcron\b/,
  },
];

function probeTopics(code: RepoFile[], importance: Map<string, number>): Topic[] {
  return TOPICS.map((t) => {
    const found: { hit: TopicHit; score: number }[] = [];
    for (const f of code) {
      if (isLowValue(f.path)) continue;
      const pathHit = t.path.test(f.path);
      let first: TopicHit | undefined;
      let hits = 0;
      const lines = f.text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits < 6; i++) {
        const l = lines[i];
        if (l.length > 400 || IMPORT_LINE.test(l) || !t.code.test(l)) continue;
        hits++;
        first ??= { path: f.path, line: i + 1, text: l.trim().slice(0, 160) };
      }
      const s = (pathHit ? 4 : 0) + hits * 0.75;
      if (s < 2.2) continue;
      first ??= firstCode(f);
      found.push({ hit: first, score: s + 0.3 * (importance.get(f.path) ?? 0) });
    }
    found.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path));
    return { id: t.id, name: t.name, hits: found.slice(0, 8).map((x) => x.hit) };
  }).filter((t) => t.hits.length > 0);
}

function firstCode(f: RepoFile): TopicHit {
  const l = codeLines(f.text).find((x) => x.text.trim() && !/^\s*(\/\/|\/\*|\*|#)/.test(x.text));
  return { path: f.path, line: l?.line ?? 1, text: (l?.text ?? '').trim().slice(0, 160) };
}

// ---- templates ----

const ATTRIBUTE = /\s([@:#*[(]?[A-Za-z_][\w:.-]*[\])]?)\s*=\s*["'{]/g;
const COMMON_ATTRIBUTES = new Set(
  (
    'class id style href src type name value alt title role width height rel for lang charset content action method target placeholder tabindex disabled ' +
    'checked selected readonly required autocomplete xmlns viewbox fill stroke d x y cx cy r points transform version encoding http-equiv async defer ' +
    'crossorigin integrity media sizes srcset loading colspan rowspan scope border align valign maxlength minlength max min step pattern accept multiple ' +
    'size rows cols wrap dir hidden draggable spellcheck frameborder allowfullscreen novalidate enctype label download sandbox allow poster preload ' +
    'controls autoplay loop muted datetime span headers form list inputmode slot part nonce xlink:href stroke-width fill-rule clip-rule stroke-linecap ' +
    'stroke-linejoin focusable x1 x2 y1 y2 rx ry offset opacity transform-origin'
  ).split(' '),
);
const TEMPLATE_SYNTAX: [string, RegExp][] = [
  ['{{ }}', /\{\{/],
  ['{% %}', /\{%/],
  ['<% %>', /<%/],
  ['Razor @', /@(model|inject|using|Html\.|\{|code\b)/],
  ['<!-- ko -->', /<!--\s*ko\s/],
  ['{Binding}', /\{(x:)?Bind(ing)?\b/],
];

function summarizeTemplates(templates: RepoFile[], importedBy: Map<string, Set<string>>): TemplateSummary {
  const ext = new Map<string, number>();
  const attrs = new Map<string, number>();
  const syntax = new Map<string, number>();
  for (const f of templates) {
    const e = `.${f.path.split('.').pop()?.toLowerCase()}`;
    ext.set(e, (ext.get(e) ?? 0) + 1);
    for (const m of f.text.matchAll(ATTRIBUTE)) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (COMMON_ATTRIBUTES.has(lower) || lower.startsWith('aria-') || lower.startsWith('xml')) continue;
      attrs.set(name, (attrs.get(name) ?? 0) + 1);
    }
    for (const [label, re] of TEMPLATE_SYNTAX) if (re.test(f.text)) syntax.set(label, (syntax.get(label) ?? 0) + 1);
  }
  const byCount = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]);
  const top = [...templates]
    .filter((f) => !isLowValue(f.path))
    .sort((a, b) => (importedBy.get(b.path)?.size ?? 0) - (importedBy.get(a.path)?.size ?? 0) || b.size - a.size)
    .slice(0, 3)
    .map((f) => f.path);
  return { count: templates.length, byExtension: byCount(ext), attributes: byCount(attrs).slice(0, 12), syntax: byCount(syntax), top };
}

// ---- paths ----

function dirOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Joins a folder and a relative path, resolving "." and "..". */
export function join(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** JSON with comments and trailing commas, like tsconfig.json. */
export function parseJsonc(text: string): unknown {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
  try {
    return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}
