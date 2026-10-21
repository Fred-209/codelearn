// Decides which files matter for learning a repo. Pure.

/** AI instruction files and other places a team writes down its conventions. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)GEMINI\.md$/i,
  /^\.github\/copilot-instructions\.md$/i,
  /^\.github\/instructions\/.+\.instructions\.md$/i,
  /^\.github\/prompts\/.+\.prompt\.md$/i,
  /^\.github\/chatmodes\/.+\.md$/i,
  /^\.cursorrules$/i,
  /^\.cursor\/rules\/.+\.(mdc|md)$/i,
  /^\.windsurfrules$/i,
  /^\.clinerules(\/.+)?$/i,
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/i,
  /^\.claude\/commands\/.+\.md$/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /^docs\/(adr|adrs|decisions|architecture)\/.+\.md$/i,
  /(^|\/)ARCHITECTURE\.md$/i,
  /^README(\.md)?$/i,
  /^[^/]+\/README\.md$/i,
  /^\.editorconfig$/i,
];

/** Files that list dependencies, frameworks and build settings. */
const MANIFEST_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/i,
  /\.(csproj|fsproj|vbproj)$/i,
  /(^|\/)Directory\.(Build|Packages)\.props$/i,
  /(^|\/)global\.json$/i,
  /\.sln$/i,
  /(^|\/)go\.mod$/i,
  /(^|\/)Cargo\.toml$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)requirements(-\w+)?\.txt$/i,
  /(^|\/)Pipfile$/i,
  /(^|\/)Gemfile$/i,
  /(^|\/)pom\.xml$/i,
  /(^|\/)build\.gradle(\.kts)?$/i,
  /(^|\/)composer\.json$/i,
  /(^|\/)pubspec\.yaml$/i,
  /(^|\/)mix\.exs$/i,
  /(^|\/)tsconfig\.json$/i,
  /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/i,
  /(^|\/)appsettings(\.\w+)?\.json$/i,
  /(^|\/)docker-compose\.ya?ml$/i,
  /(^|\/)Dockerfile$/i,
];

const CODE_EXTENSIONS = new Set([
  'cs', 'fs', 'vb', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb',
  'php', 'swift', 'm', 'mm', 'c', 'h', 'cpp', 'cc', 'hpp', 'dart', 'ex', 'exs', 'erl', 'clj', 'lua', 'r', 'jl',
  'sql', 'sh', 'ps1', 'vue', 'svelte', 'razor', 'cshtml', 'graphql', 'proto', 'tf', 'hs', 'ml', 'elm', 'zig',
]);

export type FileRole = 'instruction' | 'manifest' | 'code' | 'other';

export function classify(path: string): FileRole {
  if (INSTRUCTION_PATTERNS.some((p) => p.test(path))) return 'instruction';
  if (MANIFEST_PATTERNS.some((p) => p.test(path))) return 'manifest';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CODE_EXTENSIONS.has(ext) ? 'code' : 'other';
}

const ENTRY_NAMES = /(^|\/)(program|main|index|app|startup|server|application|bootstrap|module|routes?|urls|manage)\.[a-z]+$/i;
const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$|Tests?\.[a-z]+$/i;

/**
 * Orders code files so a sample covers the repo: entry points first, then one file
 * per folder round-robin (larger files first within a folder), tests last.
 */
export function sampleOrder(files: { path: string; size: number }[]): string[] {
  const entries = files.filter((f) => ENTRY_NAMES.test(f.path) && !TEST_PATH.test(f.path));
  const rest = files.filter((f) => !entries.includes(f));
  const byFolder = new Map<string, { path: string; size: number }[]>();
  for (const f of rest) {
    const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const list = byFolder.get(folder) ?? [];
    list.push(f);
    byFolder.set(folder, list);
  }
  for (const list of byFolder.values()) list.sort((a, b) => b.size - a.size);

  const ordered: string[] = entries.sort((a, b) => a.path.length - b.path.length).map((f) => f.path);
  const tests: string[] = [];
  const queues = [...byFolder.values()];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.shift();
      if (!next) continue;
      added = true;
      (TEST_PATH.test(next.path) ? tests : ordered).push(next.path);
    }
  }
  return [...ordered, ...tests];
}

/**
 * A rough outline for any language: lines that declare things. Used when no
 * language extension provides symbols.
 */
export function regexOutline(text: string, maxLines = 40): string[] {
  const decl =
    /^\s*(export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|sealed\s+|partial\s+|async\s+|override\s+|virtual\s+|pub(\(crate\))?\s+|default\s+)*(class|interface|struct|record|enum|trait|impl|type|module|namespace|def|fn|func|function|object|protocol|extension)\b/;
  const method = /^\s*(public|private|protected|internal)\s+[^=;]*\(/;
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    if (decl.test(l) || method.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 160)}`);
  }
  return out;
}

/** Counts the lines that start with each 2-level folder, to describe repo shape compactly. */
export function folderSummary(paths: string[], maxEntries = 80): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : '(root)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} (${n} files)`);
}
